import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Money, currency, type ReportDefinition } from "@dulja/domain";
// The PRODUCTION three-argument `withTenant` (§4.2.2), as 6C's `staff.ts` and 4B's `ar-ap.ts` use it.
import {
  applyBatch,
  importStatement,
  match,
  rebuildPartyAgeing,
  withTenant,
  type BatchOutcome,
  type TenantContext,
} from "@dulja/db";
import { grantCodes, seedAccount, seedTenantV2, uuidv7, type Db, type Seed } from "@dulja/db/test";
import type { StartedApi } from "../../../apps/api/test/support/app"; // TYPE only, exactly as staff.ts does
import { REPO_ROOT } from "../../support/source";
import { arApFixture, postFromPack } from "./ar-ap";
import { buildTicket, uuidv7Sync } from "./pos";
import type { ReportSeedEnvelope } from "./reports";
import { staffFixture, type StaffFixture } from "./staff";
import { postTaxedDocument, seedTaxPack, type TaxFixture } from "./tax";

/**
 * 7C's half of 7B's catalogue harness (contracts §4.17.1; round 15, A4). It imports `runDefinition`,
 * `assertFieldCoverage` and `assertTieOut` from `./reports` at its call sites and re-implements none of them
 * (hazard 9); it is a separate file only because `CATALOGUE_DIR` there is `…/reports/7b` and the two seed
 * directories are deliberately disjoint (§4.16.1).
 */

const MYR = currency("MYR");

/** The codes §4.16.1 assigns 7C, in the register's own order — ten, not the card's eleven: ⚠️ OD-09 is not
 *  built, so `accounting.pdc_register` is dropped with the `pdc` table it would read (round 15, A16 item 1). */
export const CATALOGUE_7C = [
  "accounting.ageing",
  "accounting.party_statement",
  "accounting.allocation_register",
  "accounting.unreconciled_items",
  "pos.z_report",
  "pos.sales_by_cashier",
  "pos.sales_by_branch",
  "pos.needs_attention",
  "accounting.branch_profit_and_loss",
  "accounting.tax_return_view",
] as const;
export type ReportCode7C = (typeof CATALOGUE_7C)[number];

export const CATALOGUE_DIR_7C = join(REPO_ROOT, "packages", "db", "seed", "my", "reports", "7c");

/** The seed-file envelope (7B amendment A1): `definitionVersion` outside, the format-version-1 definition inside.
 *  Refuses a missing file naming its path, and a file whose `definition.code` disagrees with its name. */
export function readEnvelope7C(code: string): ReportSeedEnvelope {
  const path = join(CATALOGUE_DIR_7C, `${code}.json`);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new Error(`${path}: no such report definition in 7C's seed directory`);
  }
  const parsed = JSON.parse(raw) as ReportSeedEnvelope;
  if (!Number.isInteger(parsed.definitionVersion) || parsed.definitionVersion < 1) {
    throw new Error(`${path}: definitionVersion must be an integer >= 1 (7B amendment A1)`);
  }
  if (parsed.definition?.code !== code) {
    throw new Error(
      `${path}: definition.code is ${String(parsed.definition?.code)}, the file name says ${code}`,
    );
  }
  return parsed;
}

export function readDefinition7C(code: string): ReportDefinition {
  return readEnvelope7C(code).definition;
}

export interface ArApReportFixture {
  db: Db;
  s: Seed;
  /** `s.human`: the principal `arApFixture` granted the posting codes to, plus the two report codes here. */
  reader: string;
  /** A principal id with no membership and no role in this tenant. */
  outsider: string;
  /** 4B's twelve `accountIds` plus `2300` and `1350`, the two tax controls 5A's pack resolves by code. */
  accounts: Readonly<Record<string, string>>;
  customerId: string;
  vendorId: string;
  termId: string;
  /** A taxed SALES_INVOICE (1,000.0000 net) dated 2026-01-10. */
  invoiceId: string;
  /** A taxed SALES_CREDIT_NOTE (100.0000 net) against it, dated 2026-01-15. */
  creditNoteId: string;
  /** A RECEIPT of 500.0000 dated 2026-01-20, allocated against the invoice. */
  receiptId: string;
  allocationId: string;
  /** A two-line statement for `1100` dated 2026-01-31: the receipt's line matched, a 250.0000 line open. */
  bankStatementId: string;
  matchedLineId: string;
  openLineId: string;
  /** 5A's shipped synthetic regime and its four codes, through the real pack loader (A16 item 8). */
  regimeId: string;
  taxCodes: Readonly<Record<string, string>>;
  /** 2026-01 — every document above posts in it. */
  fiscalPeriodId: string;
  /** The `party_ageing` snapshot is rebuilt for this date (4B's projection is async, spec:1204). */
  ageingAsOf: string;
}

/**
 * One AR/AP corpus every 7C accounting definition reads, in a tenant of its own: a taxed customer invoice, a
 * taxed credit note against it, a receipt allocated against the invoice, a two-line bank statement with one
 * line matched and one open, and the `party_ageing` snapshot rebuilt for the month end. It builds on 4B's
 * `arApFixture` (the pack envelopes, accounts, parties and term) and 5A's `seedTaxPack` / `postTaxedDocument`
 * (the one taxed-post path), and adds only what the reports need.
 */
export async function arApReportFixture(db: Db, name: string): Promise<ArApReportFixture> {
  const s = await seedTenantV2(db, name);
  const base = await arApFixture(db, s);
  const reader = s.human;
  const outsider = await uuidv7(db.admin);
  const ctx = async (): Promise<TenantContext> => ({
    tenantId: s.tenant,
    actorId: reader,
    requestId: await uuidv7(db.admin),
  });

  // 4B's list holds 1100, 1200, 1250, 1300, 2100, 2150, 4000, 4900, 5000, 5100, 5900 and 5910. The two tax
  // controls must exist BEFORE the pack loads: a tax code resolves its output/input account by code.
  const accounts: Record<string, string> = { ...base.accountIds };
  for (const a of [
    { code: "2300", nameEn: "Output tax payable", type: "liability" },
    { code: "1350", nameEn: "Input tax receivable", type: "asset" },
  ] as const) {
    accounts[a.code] = await seedAccount(db, s, a);
  }

  // The report codes the 7C definitions declare that `arApFixture` does not grant, and the tax code 5A's
  // engine and `accounting.tax_return_view` read under.
  await grantCodes(db, s, {
    codes: ["accounting.report.read", "accounting.tax.manage"],
    principalId: reader,
    roleCode: `${name}-reader`,
  });

  // The SHIPPED synthetic pack through its real loader — never a hand-inserted code at a chosen rate (hazard 1,
  // A16 item 8). Nothing in 7C asserts the rate: the tax report renders what 5A's engine stored.
  const pack = await seedTaxPack(db, s);
  const taxWorld: TaxFixture = {
    s,
    regimeId: pack.regimeId,
    codes: pack.codes,
    accounts,
    types: { ...base.documentTypeIds },
    customerId: base.partyIds.customer,
    vendorId: base.partyIds.vendor,
    poster: reader,
  };
  const { documentId: invoiceId } = await postTaxedDocument(db, taxWorld, {
    typeCode: "SALES_INVOICE",
    effectiveDate: "2026-01-10",
    lines: [
      {
        lineNo: 1,
        kind: "account",
        accountId: accounts["4000"]!,
        amount: "1000.0000",
        taxCode: "SYN-OUT-STD",
      },
    ],
  });
  // `postTaxedDocument` credits only against a posted invoice line carrying the SAME tax code, so the credit
  // note is taxed too — which also gives `tax_transaction` a signed (negative) row.
  const { documentId: creditNoteId } = await postTaxedDocument(db, taxWorld, {
    typeCode: "SALES_CREDIT_NOTE",
    effectiveDate: "2026-01-15",
    lines: [{ lineNo: 1, amount: "100.0000", taxCode: "SYN-OUT-STD" }],
  });

  // A RECEIPT is one bank line against the party's control (4A's pack policy); `allocate` runs 4A's
  // `allocateSettlement` after the post. 500.0000 settles part of the invoice, so the ageing keeps a balance.
  const { documentId: receiptId } = await postFromPack(db, s, {
    code: "RECEIPT",
    effectiveDate: "2026-01-20",
    partyId: base.partyIds.customer,
    lines: [{ kind: "account", accountId: accounts["1100"]!, amount: "500.0000" }],
    allocate: [{ settledDocumentId: invoiceId, amount: Money.of("500.0000", MYR) }],
  });
  const [allocation] = await withTenant(
    db.rw,
    await ctx(),
    (tx) => tx<{ id: string }[]>`
      select id::text as id from app.allocation
       where company_id = ${s.company} and settlement_document_id = ${receiptId}
       order by created_at asc, id asc limit 1`,
  );
  if (allocation === undefined) throw new Error(`${name}: the receipt allocated nothing`);

  // A two-line statement: the receipt's 500.00 and an unknown 250.00 credit.
  const importCtx = await ctx();
  const { statementId } = await withTenant(db.rw, importCtx, (tx) =>
    importStatement(tx, importCtx, {
      companyId: s.company,
      bankAccountId: accounts["1100"]!,
      csv: [
        "Date,Narrative,Ref,Amount",
        "2026-01-20,RECEIPT CUST-1,R1,500.00",
        "2026-01-21,UNKNOWN CREDIT,U1,250.00",
      ].join("\n"),
      mapping: {
        statement: {
          statementDate: "2026-01-31",
          openingBalance: "0.0000",
          closingBalance: "750.0000",
        },
        columns: {
          valueDate: "Date",
          description: "Narrative",
          reference: "Ref",
          amount: "Amount",
        },
        dateFormat: "YYYY-MM-DD",
        hasHeader: true,
      },
    }),
  );
  const lines = await withTenant(
    db.rw,
    await ctx(),
    (tx) => tx<{ id: string }[]>`
      select id::text as id from app.bank_statement_line
       where statement_id = ${statementId} order by line_no asc`,
  );
  const matchedLineId = lines[0]!.id;
  const openLineId = lines[1]!.id;
  const matchCtx = await ctx();
  await withTenant(db.rw, matchCtx, (tx) =>
    match(tx, matchCtx, {
      companyId: s.company,
      statementLineId: matchedLineId,
      reconcilable: { kind: "receipt", documentId: receiptId },
      amount: Money.of("500.0000", MYR),
    }),
  );

  // 4B's `party_ageing` is an ASYNC projection (spec:1204): the nightly job rebuilds it, so the fixture does.
  const ageingAsOf = "2026-01-31";
  await withTenant(db.rw, await ctx(), (tx) =>
    rebuildPartyAgeing(tx, { companyId: s.company, asOf: ageingAsOf }),
  );

  return {
    db,
    s,
    reader,
    outsider,
    accounts,
    customerId: base.partyIds.customer,
    vendorId: base.partyIds.vendor,
    termId: base.termId,
    invoiceId,
    creditNoteId,
    receiptId,
    allocationId: allocation.id,
    bankStatementId: statementId,
    matchedLineId,
    openLineId,
    regimeId: pack.regimeId,
    taxCodes: pack.codes,
    fiscalPeriodId: s.period,
    ageingAsOf,
  };
}

export interface PosReportFixture {
  api: StartedApi;
  db: Db;
  s: Seed;
  staff: StaffFixture;
  /** `s.human`, granted `pos.report.read`, `pos.needs_attention.resolve` and `accounting.report.read`
   *  company-wide. */
  reader: string;
  /** Branch A's first shift, closed: three sales (cash 40.00, cash 10.00, card 25.00), a fourth cash sale of
   *  30.00 voided by `supervisorA`, a 10.00 cash refund of the second sale, one no-sale, and a count of 138.0000
   *  against an expected 140.0000 — a 2.0000 short. Verified against 6D's own functions: `zReport` counts four
   *  tickets and two returns (the void's posted mirror is a return) and `salesByCashier` nets 58.5585 — the
   *  tax-inclusive 65.00 less the synthetic output tax — exactly what the `shift` dataset's laterals return. */
  closedShiftId: string;
  /** Branch A's second shift, still open, with a 50.0000 float. The company also holds the two ticketless
   *  shifts 6A's `posFixture` and 6C's `staffFixture` open (`staff.pos.shiftId`, `staff.shiftA`), so a POS
   *  report over a date range lists four shifts, two of them with no takings. */
  openShiftId: string;
  branchA: string;
  branchB: string;
  /** The ticket refused into `app.needs_attention` (an over-limit line discount, `ERR_POS_LIMIT_EXCEEDED`). */
  rejectedClientRef: string;
  /** The sale the supervisor voided (posted, then reversed by the void). */
  voidedTicketRef: string;
  /** The `void` till event's own ref. */
  voidEventRef: string;
  /** The `YYYY-MM-DD` the day was synced on, UTC; the tickets' effective date in the company's timezone may
   *  be a day later, so a POS date window spans `[day − 1, day + 1]` (6D's test 21 does the same). */
  day: string;
}

/**
 * One trading day at branch A driven entirely through 6A's `applyBatch` — the shifts, the tickets, the till
 * events and the close — over 6C's `staffFixture`. Nothing POS-shaped is inserted directly: a row written past
 * `applyBatch` would prove nothing about the reports (hazard 22). Every message is asserted accepted (or, for the
 * one refused ticket, rejected) as it goes, so a fixture that silently half-applied fails here, not in a tie-out.
 */
export async function posReportFixture(api: StartedApi, name: string): Promise<PosReportFixture> {
  const db = api.db;
  const staff = await staffFixture(api, name);
  const s = staff.seed;
  const reader = s.human;
  await grantCodes(db, s, {
    codes: ["pos.report.read", "pos.needs_attention.resolve", "accounting.report.read"],
    principalId: reader,
    roleCode: `${name}-reader`,
  });
  // The cashier owns the shift and voids under a supervisor, as 6D's test 21 grants it.
  await grantCodes(db, s, {
    principalId: staff.cashierA,
    branchIds: [staff.branchA],
    codes: ["pos.shift.own", "pos.ticket.void"],
    roleCode: `${name}-own`,
  });

  // `applyBatch(tx, ctx, terminal, batch)`: `ctx` acts as the TERMINAL, never the cashier (hazard 19), and
  // `terminal` carries the company and branch — 6C's `applyTicket` passes both the same way.
  const apply = async (batch: {
    tickets?: unknown[];
    shifts?: unknown[];
    tillEvents?: unknown[];
  }): Promise<BatchOutcome> => {
    const ctx: TenantContext = {
      tenantId: s.tenant,
      actorId: staff.terminalA.principalId,
      requestId: crypto.randomUUID(),
    };
    const terminal = {
      terminalId: staff.terminalA.terminalId,
      companyId: s.company,
      branchId: staff.branchA,
      principalId: staff.terminalA.principalId,
    };
    return withTenant(db.rw, ctx, (tx) =>
      applyBatch(tx, ctx, terminal, {
        terminalId: terminal.terminalId,
        batchId: uuidv7Sync(),
        tickets: (batch.tickets ?? []) as never,
        shifts: batch.shifts ?? [],
        tillEvents: batch.tillEvents ?? [],
      }),
    );
  };
  const accepted = (label: string, out: BatchOutcome): void => {
    for (const r of [...out.results, ...out.shiftResults, ...out.tillEventResults]) {
      if (r.status !== "accepted") {
        throw new Error(`${name}: ${label} was ${r.status}: ${JSON.stringify(r.error)}`);
      }
    }
  };
  const shiftMessage = (
    shiftId: string,
    kind: "open" | "close",
    at: Date,
    money: { openingFloat?: string; countedCash?: string },
  ) => ({
    shiftId,
    kind,
    terminalId: staff.terminalA.terminalId,
    cashierPrincipalId: staff.cashierA,
    at: at.toISOString(),
    currency: "MYR",
    openingFloat:
      money.openingFloat === undefined ? null : { amount: money.openingFloat, currency: "MYR" },
    countedCash:
      money.countedCash === undefined ? null : { amount: money.countedCash, currency: "MYR" },
  });
  const sale = (shiftId: string, unitPrice: string, tender: "cash" | "card", clientRef?: string) =>
    buildTicket(staff.pos, {
      sku: "SKU-A",
      shiftId,
      cashierPrincipalId: staff.cashierA,
      unitPrice,
      tender,
      ...(clientRef === undefined ? {} : { clientRef }),
    });

  const day = new Date().toISOString().slice(0, 10);
  const closedShiftId = uuidv7Sync();
  accepted(
    "the first open",
    await apply({
      shifts: [shiftMessage(closedShiftId, "open", new Date(), { openingFloat: "100.0000" })],
    }),
  );
  const refundedRef = uuidv7Sync();
  const voidedTicketRef = uuidv7Sync();
  accepted(
    "the sales",
    await apply({
      tickets: [
        sale(closedShiftId, "40.0000", "cash"),
        sale(closedShiftId, "10.0000", "cash", refundedRef),
        sale(closedShiftId, "25.0000", "card"),
        sale(closedShiftId, "30.0000", "cash", voidedTicketRef),
      ],
    }),
  );
  accepted(
    "the refund",
    await apply({
      tickets: [
        buildTicket(staff.pos, {
          sku: "SKU-A",
          shiftId: closedShiftId,
          cashierPrincipalId: staff.cashierA,
          kind: "return",
          returnsClientRef: refundedRef,
          unitPrice: "10.0000",
          tender: "cash",
        }),
      ],
    }),
  );
  // The void precedes the close in the same batch, so the count includes its reversal (6D's test 21 order).
  // Expected cash is 100 + 40 + 10 − 10 + 30 − 30 = 140.0000; the cashier counts 138.0000.
  const voidEventRef = uuidv7Sync();
  accepted(
    "the till events and the close",
    await apply({
      tillEvents: [
        {
          clientRef: uuidv7Sync(),
          shiftId: closedShiftId,
          kind: "no_sale",
          ticketClientRef: null,
          cashierPrincipalId: staff.cashierA,
          supervisorPrincipalId: null,
          reason: null,
          occurredAt: new Date().toISOString(),
        },
        {
          clientRef: voidEventRef,
          shiftId: closedShiftId,
          kind: "void",
          ticketClientRef: voidedTicketRef,
          cashierPrincipalId: staff.cashierA,
          supervisorPrincipalId: staff.supervisorA,
          reason: "Customer changed their mind",
          occurredAt: new Date().toISOString(),
        },
      ],
      shifts: [
        shiftMessage(closedShiftId, "close", new Date(Date.now() + 1000), {
          countedCash: "138.0000",
        }),
      ],
    }),
  );

  // The second shift stays open; its one ticket is refused into needs_attention — a 25 % line discount where
  // branch A's limit is 10 % (6C's `staffFixture`), so the refusal is the server's authority check.
  const openShiftId = uuidv7Sync();
  accepted(
    "the second open",
    await apply({
      shifts: [
        shiftMessage(openShiftId, "open", new Date(Date.now() + 2000), { openingFloat: "50.0000" }),
      ],
    }),
  );
  const rejected = buildTicket(staff.pos, {
    sku: "SKU-A",
    shiftId: openShiftId,
    cashierPrincipalId: staff.cashierA,
    unitPrice: "100.0000",
    discount: "25.0000",
    tender: "cash",
  });
  const refused = await apply({ tickets: [rejected] });
  if (refused.results[0]?.status !== "rejected") {
    throw new Error(`${name}: the over-limit ticket was ${JSON.stringify(refused.results[0])}`);
  }

  return {
    api,
    db,
    s,
    staff,
    reader,
    closedShiftId,
    openShiftId,
    branchA: staff.branchA,
    branchB: staff.branchB,
    rejectedClientRef: rejected.clientRef,
    voidedTicketRef,
    voidEventRef,
    day,
  };
}

/**
 * The parameters each 7C definition runs under, in ONE place: the group tests
 * (`packages/db/test/reports/7c-ar-ap.test.ts`, `apps/api/test/routes/reports/7c-pos-cross-module.test.ts`) and
 * the slice-exit roll-up (`tests/invariants/report-tie-out-7c.test.ts`) all read these, so a filter, its
 * parameter and its proof cannot drift apart. `companyId` is in every branch: `runDefinition` binds it into the
 * dataset's `company` fragment and `assertTieOut` into its independent query. `accounting.ageing` carries no
 * `partyKind`, deliberately: both of its proofs compare against an UNFILTERED source, and the filter is proven on
 * its own case.
 */
export function paramsFor(code: string, f: ArApReportFixture): Record<string, string> {
  const base = { companyId: f.s.company };
  switch (code) {
    case "accounting.ageing":
      return { ...base, asOf: f.ageingAsOf };
    case "accounting.party_statement":
      return { ...base, partyId: f.customerId, fromDate: "2026-01-01", toDate: "2026-01-31" };
    case "accounting.allocation_register":
      return { ...base, fromDate: "2026-01-01", toDate: "2026-01-31" };
    case "accounting.unreconciled_items":
      return {
        ...base,
        isMatched: "false",
        bankAccountId: f.accounts["1100"]!,
        fromDate: "2026-01-01",
        toDate: "2026-01-31",
      };
    default:
      throw new Error(`no parameters registered for ${code}`);
  }
}

/** A POS date window. `posReportFixture` dates its corpus `now()` and both 6D and the `shift` dataset bucket in
 *  the company's timezone, so the window is the run date ± 1 day (round 15, A16 items 3 and 19). */
export interface PosRange {
  fromDate: string;
  toDate: string;
}

const dayOffset = (offset: number): string =>
  new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

export function posRange(): PosRange {
  return { fromDate: dayOffset(-1), toDate: dayOffset(1) };
}

export function posParams(
  code: string,
  p: PosReportFixture,
  range: PosRange,
): Record<string, string> {
  const base = { companyId: p.s.company };
  switch (code) {
    case "pos.z_report":
      return { ...base, shiftId: p.closedShiftId };
    case "pos.sales_by_cashier":
    case "pos.sales_by_branch":
      return { ...base, fromDate: range.fromDate, toDate: range.toDate };
    case "pos.needs_attention":
      return { ...base, isOpen: "true" };
    default:
      throw new Error(`no parameters registered for ${code}`);
  }
}

export function crossParams(code: string, a: ArApReportFixture): Record<string, string> {
  const base = { companyId: a.s.company };
  switch (code) {
    // `branchId` is not optional in practice: without it `rowsForDefinition` takes `statementRows`'
    // account_balance fallback, whose rows carry no `branch_id` (A5). `s.hq` is the branch every
    // `arApReportFixture` document posted to.
    case "accounting.branch_profit_and_loss":
      return { ...base, fiscalPeriodId: a.fiscalPeriodId, branchId: a.s.hq };
    case "accounting.tax_return_view":
      return { ...base, fiscalPeriodId: a.fiscalPeriodId, taxCodeKind: "output" };
    default:
      throw new Error(`no parameters registered for ${code}`);
  }
}
