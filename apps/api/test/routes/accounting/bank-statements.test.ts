import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  BankMatchSchema,
  BankStatementLineList,
  BankStatementList,
  ReconciledBalanceSchema,
} from "@dulja/contracts";
import { grantCodes, seedTenantV2, uuidv7, withTenant, type Seed } from "@dulja/db/test";
// FIVE levels: this file is `apps/api/test/routes/accounting/`, so the repository root is five directories up.
import { problemOf } from "../../../../../tests/support/api";
import {
  arApFixture,
  postFromPack,
  type ArApFixture,
} from "../../../../../tests/invariants/support/ar-ap";
import { secondPrincipal } from "../../../../../tests/invariants/support/post-inventory";
import { startApi, type StartedApi } from "../../support/app";

/**
 * `/v1/companies/{companyId}/bank-statements` — 4B Task 8, the slice's one new route module (contracts §4.8.3,
 * ADR 0048): import, the two lists, match, unmatch and the reconciliation. Every handler passes the PATH
 * company into every service call, because RLS bounds the tenant and nothing else (AGENTS.md).
 *
 * The receipt and payment are posted through 4A's REAL pack envelopes; their policies take ONE account line
 * carrying the amount and derive the control-account leg from the party, so a line names the bank only (Task 7's
 * `bank-match.test.ts` records the same fact against the plan's two-line form).
 */
const MODULE = "/v1/companies/:companyId/bank-statements";

const JANUARY = [
  "Date,Narrative,Ref,Amount",
  "2026-01-05,RECEIPT CUST-1,R1,900.00",
  "2026-01-08,PAYMENT VEND-1,P1,-300.00",
].join("\n");
const COLUMNS = { valueDate: "Date", description: "Narrative", reference: "Ref", amount: "Amount" };
const mapping = (statementDate: string, openingBalance: string, closingBalance: string) => ({
  statement: { statementDate, openingBalance, closingBalance },
  columns: COLUMNS,
  dateFormat: "YYYY-MM-DD" as const,
  hasHeader: true,
});

describe("the bank-statements route module (§4.2.7, §4.8.3)", () => {
  let api: StartedApi;
  let s: Seed;
  let f: ArApFixture;
  let bank: string;
  let receiptId: string;
  let paymentId: string;
  let outsider: string;
  let sibling: { companyId: string; bankId: string };
  let january: string;
  let february: string;
  let receiptLine: string;
  let paymentLine: string;
  let paymentMatch: string;
  let rematch: string;

  const base = (companyId?: string) => `/v1/companies/${companyId ?? s.company}/bank-statements`;
  const recon = (query: string, companyId = s.company) =>
    api.request({ method: "GET", as: s.human, path: `${base(companyId)}/reconciliation?${query}` });
  const janRecon = () => recon(`filter[bank_account_id][eq]=${bank}&filter[as_of][eq]=2026-01-31`);
  const linesOf = async (statementId: string, query = "") => {
    const res = await api.request({
      method: "GET",
      as: s.human,
      path: `${base()}/${statementId}/lines${query}`,
    });
    expect(res.status).toBe(200);
    return BankStatementLineList.parse(await res.json());
  };
  const matchLine = (
    statementId: string,
    lineId: string,
    body: { kind: string; documentId: string; amount: string },
    companyId = s.company,
  ) =>
    api.request({
      method: "POST",
      as: s.human,
      path: `${base(companyId)}/${statementId}/lines/${lineId}/matches`,
      body: {
        kind: body.kind,
        documentId: body.documentId,
        amount: { amount: body.amount, currency: "MYR" },
      },
    });

  beforeAll(async () => {
    api = await startApi();
    s = await seedTenantV2(api.db, "BankStatementsAPI");
    // The fixture grants `accounting.bank.reconcile` to `s.human` among its posting codes.
    f = await arApFixture(api.db, s);
    bank = f.accountIds["1100"]!;
    ({ documentId: receiptId } = await postFromPack(api.db, s, {
      code: "RECEIPT",
      effectiveDate: "2026-01-05",
      partyId: f.partyIds.customer,
      lines: [{ kind: "account", accountId: bank, amount: "900.0000" }],
    }));
    ({ documentId: paymentId } = await postFromPack(api.db, s, {
      code: "PAYMENT",
      effectiveDate: "2026-01-08",
      partyId: f.partyIds.vendor,
      lines: [{ kind: "account", accountId: bank, amount: "300.0000" }],
    }));
    // A member of the tenant holding no code at all.
    outsider = await secondPrincipal(api.db, s, "bank-outsider");

    // A sibling company of the SAME tenant, with a bank account of its own, in which `s.human` ALSO holds
    // the reconcile code — so the gate passes for it and only the path company's binding stands between a
    // sibling-company request and this company's rows.
    const roleId = await grantCodes(api.db, s, {
      codes: ["accounting.bank.reconcile"],
      roleCode: "bank-sibling-reconciler",
    });
    sibling = await withTenant(api.db.migrator, s.tenant, s.system, async (tx) => {
      const [company] = await tx<{ id: string }[]>`
        insert into app.company (tenant_id, code, name, base_currency)
        values (${s.tenant}, 'BANK-SIB', 'Bank sibling company', 'MYR') returning id`;
      const [account] = await tx<{ id: string }[]>`
        insert into app.account (tenant_id, company_id, code, name_en, type)
        values (${s.tenant}, ${company!.id}, '1100', 'Sibling bank', 'asset') returning id`;
      await tx`insert into app.role_assignment (tenant_id, principal_id, role_id, company_id)
               values (${s.tenant}, ${s.human}, ${roleId}, ${company!.id})`;
      return { companyId: company!.id, bankId: account!.id };
    });
  }, 600_000);
  afterAll(async () => {
    await api?.stop();
  });

  // The PROBES half of hazard 31 is asserted where PROBES lives (`tests/invariants/tenant-isolation.test.ts`
  // compares its key set with ROUTES); this workspace may import neither `tests/invariants/probes.ts` nor itself
  // as `@dulja/api` (dependency-rule), so ROUTES is read by relative path.
  it("is registered once, on its own path, with the one gate code", async () => {
    const { ROUTES } = await import("../../../src/routes");
    const mounted = ROUTES.filter((m) => m.path === MODULE);
    expect(mounted).toHaveLength(1);
    expect(mounted[0]!.permissions).toEqual(["accounting.bank.reconcile"]);
    expect(mounted[0]!.auth).toBe("human");
  });

  it("POST imports a statement that adds up: 201 with its id and line count", async () => {
    const res = await api.request({
      method: "POST",
      as: s.human,
      path: base(),
      body: {
        bankAccountId: bank,
        csv: JANUARY,
        mapping: mapping("2026-01-31", "0.0000", "600.0000"),
      },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { statementId: string; lines: number };
    expect(body.lines).toBe(2);
    january = body.statementId;
  });

  it("POST refuses a statement that does not add up (400) and a second one for the same date (409)", async () => {
    const short = await api.request({
      method: "POST",
      as: s.human,
      path: base(),
      body: {
        bankAccountId: bank,
        csv: JANUARY,
        mapping: mapping("2026-01-30", "0.0000", "700.0000"),
      },
    });
    expect(short.status).toBe(400);
    const problem = await problemOf(short);
    expect(problem.code).toBe("ERR_VALIDATION_FAILED");
    expect(problem.detail).toMatch(/does not add up/);

    const again = await api.request({
      method: "POST",
      as: s.human,
      path: base(),
      body: {
        bankAccountId: bank,
        csv: JANUARY,
        mapping: mapping("2026-01-31", "0.0000", "600.0000"),
      },
    });
    expect(again.status).toBe(409);
    expect((await problemOf(again)).code).toBe("ERR_CONFLICT_UNIQUE");

    // A malformed mapping never reaches the service: both amount forms at once is a Zod refusal.
    const both = await api.request({
      method: "POST",
      as: s.human,
      path: base(),
      body: {
        bankAccountId: bank,
        csv: JANUARY,
        mapping: {
          ...mapping("2026-01-29", "0.0000", "600.0000"),
          columns: { ...COLUMNS, debit: "Debit" },
        },
      },
    });
    expect(both.status).toBe(400);
    expect((await problemOf(both)).code).toBe("ERR_VALIDATION_FAILED");
  });

  it("GET lists the company's statements, filtered by bank account", async () => {
    const all = await api.request({ method: "GET", as: s.human, path: base() });
    expect(all.status).toBe(200);
    const body = BankStatementList.parse(await all.json());
    expect(body).toEqual({
      items: [
        {
          id: january,
          bankAccountId: bank,
          statementDate: "2026-01-31",
          openingBalance: "0.0000",
          closingBalance: "600.0000",
          currency: "MYR",
          lines: 2,
        },
      ],
      next_cursor: null,
    });
    const elsewhere = await api.request({
      method: "GET",
      as: s.human,
      path: `${base()}?filter[bank_account_id][eq]=${await uuidv7(api.db.admin)}`,
    });
    expect(BankStatementList.parse(await elsewhere.json()).items).toEqual([]);
    const mine = await api.request({
      method: "GET",
      as: s.human,
      path: `${base()}?filter[bank_account_id][eq]=${bank}`,
    });
    expect(BankStatementList.parse(await mine.json()).items.map((r) => r.id)).toEqual([january]);
    // §4.2.8 Layer 2: the query is strict, so a misspelt key is a 400 and never a 200 over the wrong rows.
    const misspelt = await api.request({
      method: "GET",
      as: s.human,
      path: `${base()}?filter[bank_acount_id][eq]=${bank}`,
    });
    expect(misspelt.status).toBe(400);
  });

  it("GET …/{statementId}/lines lists the lines with their matched amount", async () => {
    const { items, next_cursor } = await linesOf(january);
    expect(next_cursor).toBeNull();
    expect(
      items.map((l) => [l.lineNo, l.valueDate, l.reference, l.amount, l.matchedAmount]),
    ).toEqual([
      [1, "2026-01-05", "R1", "900.0000", "0.0000"],
      [2, "2026-01-08", "P1", "-300.0000", "0.0000"],
    ]);
    receiptLine = items[0]!.id;
    paymentLine = items[1]!.id;
  });

  it("an over-match and a match in the wrong direction are 422 ERR_BANK_MATCH_AMOUNT problem+json", async () => {
    const over = await matchLine(january, receiptLine, {
      kind: "receipt",
      documentId: receiptId,
      amount: "5000.0000",
    });
    expect(over.status).toBe(422);
    expect(over.headers.get("content-type")).toMatch(/application\/problem\+json/);
    const problem = (await over.json()) as { code: string; type: string };
    expect(problem.code).toBe("ERR_BANK_MATCH_AMOUNT");
    expect(problem.type).toBe("urn:dulja:error:ERR_BANK_MATCH_AMOUNT");

    // A receipt is money IN; the payment's line is money OUT.
    const backwards = await matchLine(january, paymentLine, {
      kind: "receipt",
      documentId: receiptId,
      amount: "300.0000",
    });
    expect(backwards.status).toBe(422);
    expect((await problemOf(backwards)).detail).toMatch(/direction disagrees/);
    // Nothing was written by either refusal.
    expect((await linesOf(january)).items.map((l) => l.matchedAmount)).toEqual([
      "0.0000",
      "0.0000",
    ]);
  });

  it("matches both lines, after which the month reconciles: statement = ledger, nothing listed", async () => {
    const receipt = await matchLine(january, receiptLine, {
      kind: "receipt",
      documentId: receiptId,
      amount: "900.0000",
    });
    expect(receipt.status).toBe(201);
    expect((await receipt.json()) as { matchId: string }).toMatchObject({
      matchId: expect.any(String) as string,
    });
    const payment = await matchLine(january, paymentLine, {
      kind: "payment",
      documentId: paymentId,
      amount: "300.0000",
    });
    expect(payment.status).toBe(201);
    paymentMatch = ((await payment.json()) as { matchId: string }).matchId;

    const res = await janRecon();
    expect(res.status).toBe(200);
    const body = ReconciledBalanceSchema.parse(await res.json());
    expect(body).toEqual({
      statement: { amount: "600.0000", currency: "MYR" },
      ledger: { amount: "600.0000", currency: "MYR" },
      unreconciled: [],
      unmatchedLines: [],
    });
    // filter[matched][eq] splits the statement: `true` is the fully matched lines, `false` the rest.
    expect((await linesOf(january, "?filter[matched][eq]=true")).items).toHaveLength(2);
    expect((await linesOf(january, "?filter[matched][eq]=false")).items).toEqual([]);
  });

  it("POST …/matches/{matchId}/unmatch keeps the row, stores the reason, and re-lists both sides", async () => {
    const res = await api.request({
      method: "POST",
      as: s.human,
      path: `${base()}/matches/${paymentMatch}/unmatch`,
      body: { reason: "wrong line" },
    });
    expect(res.status).toBe(200);
    const row = BankMatchSchema.parse(await res.json());
    expect(row).toMatchObject({
      id: paymentMatch,
      statementLineId: paymentLine,
      kind: "payment",
      reconcilableDocumentId: paymentId,
      amount: { amount: "300.0000", currency: "MYR" },
      unmatchReason: "wrong line",
    });
    expect(row.unmatchedAt).not.toBeNull();

    const body = ReconciledBalanceSchema.parse(await (await janRecon()).json());
    expect(body.statement).toEqual(body.ledger);
    expect(body.unreconciled).toEqual([
      {
        kind: "payment",
        documentId: paymentId,
        bankAccountId: bank,
        valueDate: "2026-01-08",
        amount: { amount: "300.0000", currency: "MYR" },
        reference: expect.any(String) as string,
      },
    ]);
    expect(body.unmatchedLines.map((l) => [l.id, l.amount, l.matchedAmount])).toEqual([
      [paymentLine, "-300.0000", "0.0000"],
    ]);
    expect((await linesOf(january, "?filter[matched][eq]=false")).items.map((l) => l.id)).toEqual([
      paymentLine,
    ]);

    // Once only: a second unmatch of the same row is refused, and a blank reason is bad input.
    const twice = await api.request({
      method: "POST",
      as: s.human,
      path: `${base()}/matches/${paymentMatch}/unmatch`,
      body: { reason: "again" },
    });
    expect(twice.status).toBe(422);
    expect((await problemOf(twice)).code).toBe("ERR_BANK_MATCH_AMOUNT");
    const again = await matchLine(january, paymentLine, {
      kind: "payment",
      documentId: paymentId,
      amount: "300.0000",
    });
    expect(again.status).toBe(201);
    rematch = ((await again.json()) as { matchId: string }).matchId;
    const blank = await api.request({
      method: "POST",
      as: s.human,
      path: `${base()}/matches/${rematch}/unmatch`,
      body: { reason: "   " },
    });
    expect(blank.status).toBe(400);
    expect((await problemOf(blank)).code).toBe("ERR_VALIDATION_FAILED");
  });

  it("every unsafe method requires Idempotency-Key (spec:2055)", async () => {
    for (const [path, body] of [
      [
        base(),
        { bankAccountId: bank, csv: JANUARY, mapping: mapping("2026-01-31", "0.0000", "600.0000") },
      ],
      [
        `${base()}/${january}/lines/${paymentLine}/matches`,
        { kind: "payment", documentId: paymentId, amount: { amount: "1.0000", currency: "MYR" } },
      ],
      [`${base()}/matches/${paymentMatch}/unmatch`, { reason: "no key" }],
    ] as const) {
      const res = await api.request({
        method: "POST",
        as: s.human,
        path,
        idempotencyKey: null,
        body,
      });
      expect(res.status, path).toBe(400);
      expect((await problemOf(res)).code).toBe("ERR_IDEMPOTENCY_KEY_MISSING");
    }
  });

  it("a replayed import answers the stored response and imports nothing a second time (§4.2.9)", async () => {
    const request = {
      method: "POST" as const,
      as: s.human,
      path: base(),
      idempotencyKey: "4b-bank-statement-replay",
      body: {
        bankAccountId: bank,
        csv: ["Date,Narrative,Ref,Amount", "2026-02-03,INTEREST,I1,10.00"].join("\n"),
        mapping: mapping("2026-02-28", "600.0000", "610.0000"),
      },
    };
    const first = await api.request(request);
    expect(first.status).toBe(201);
    const replay = await api.request(request);
    expect(replay.status).toBe(201);
    expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
    const firstBody = (await first.json()) as { statementId: string };
    expect(await replay.json()).toEqual(firstBody);
    february = firstBody.statementId;
    const list = BankStatementList.parse(
      await (await api.request({ method: "GET", as: s.human, path: base() })).json(),
    );
    expect(list.items.map((r) => [r.id, r.statementDate])).toEqual([
      [february, "2026-02-28"],
      [january, "2026-01-31"],
    ]);
  });

  it("keysets both lists: a full page carries a cursor, the last page none", async () => {
    const page = async (path: string) => {
      const res = await api.request({ method: "GET", as: s.human, path });
      expect(res.status, path).toBe(200);
      return (await res.json()) as { items: { id: string }[]; next_cursor: string | null };
    };
    // One row past the page decides whether there is a next one, so an exactly full last page carries none.
    const one = await page(`${base()}?limit=1`);
    expect(one.items.map((r) => r.id)).toEqual([february]);
    expect(one.next_cursor).not.toBeNull();
    const two = await page(`${base()}?limit=1&cursor=${one.next_cursor!}`);
    expect(two).toEqual({ items: [expect.objectContaining({ id: january })], next_cursor: null });
    expect((await page(`${base()}?limit=2`)).next_cursor).toBeNull();

    const first = await page(`${base()}/${january}/lines?limit=1`);
    expect(first.items.map((l) => l.id)).toEqual([receiptLine]);
    expect(first.next_cursor).not.toBeNull();
    const second = await page(`${base()}/${january}/lines?limit=1&cursor=${first.next_cursor!}`);
    expect(second).toEqual({
      items: [expect.objectContaining({ id: paymentLine })],
      next_cursor: null,
    });
    // The filter and the keyset compose: the unmatched lines after line 1 are none, all being matched.
    expect(
      await page(
        `${base()}/${january}/lines?filter[matched][eq]=false&cursor=${first.next_cursor!}`,
      ),
    ).toEqual({ items: [], next_cursor: null });

    const forged = await api.request({
      method: "GET",
      as: s.human,
      path: `${base()}/${january}/lines?cursor=${Buffer.from('{"k":["x"],"id":"y"}').toString("base64url")}`,
    });
    expect(forged.status).toBe(400);
  });

  it.each([
    ["no as_of", () => `filter[bank_account_id][eq]=${bank}`],
    ["no bank account", () => "filter[as_of][eq]=2026-01-31"],
    [
      "an impossible date",
      () => `filter[bank_account_id][eq]=${bank}&filter[as_of][eq]=2026-02-30`,
    ],
    [
      "a bank account that is no uuid",
      () => "filter[bank_account_id][eq]=1100&filter[as_of][eq]=2026-01-31",
    ],
    [
      "an undeclared key",
      () => `filter[bank_account_id][eq]=${bank}&filter[as_of][eq]=2026-01-31&asOf=2026-01-31`,
    ],
  ])("GET …/reconciliation refuses %s with ERR_VALIDATION_FAILED", async (_label, query) => {
    const res = await recon(query());
    expect(res.status).toBe(400);
    expect((await problemOf(res)).code).toBe("ERR_VALIDATION_FAILED");
  });

  it("the path company binds every statement, line, match and account the request names (AGENTS.md)", async () => {
    const siblingList = await api.request({
      method: "GET",
      as: s.human,
      path: base(sibling.companyId),
    });
    expect(siblingList.status).toBe(200);
    expect(BankStatementList.parse(await siblingList.json()).items).toEqual([]);

    const cases: [string, Promise<Response>][] = [
      [
        "this company's statement read through the sibling's path",
        api.request({
          method: "GET",
          as: s.human,
          path: `${base(sibling.companyId)}/${january}/lines`,
        }),
      ],
      [
        "this company's line matched through the sibling's path",
        matchLine(
          january,
          receiptLine,
          { kind: "receipt", documentId: receiptId, amount: "1.0000" },
          sibling.companyId,
        ),
      ],
      [
        "this company's match unmatched through the sibling's path",
        api.request({
          method: "POST",
          as: s.human,
          path: `${base(sibling.companyId)}/matches/${paymentMatch}/unmatch`,
          body: { reason: "not mine" },
        }),
      ],
      [
        "this company's bank account reconciled through the sibling's path",
        recon(
          `filter[bank_account_id][eq]=${bank}&filter[as_of][eq]=2026-01-31`,
          sibling.companyId,
        ),
      ],
      [
        "this company's bank account imported into through the sibling's path",
        api.request({
          method: "POST",
          as: s.human,
          path: base(sibling.companyId),
          body: {
            bankAccountId: bank,
            csv: JANUARY,
            mapping: mapping("2026-01-31", "0.0000", "600.0000"),
          },
        }),
      ],
      [
        "the sibling's bank account reconciled through this company's path",
        recon(`filter[bank_account_id][eq]=${sibling.bankId}&filter[as_of][eq]=2026-01-31`),
      ],
    ];
    for (const [label, pending] of cases) {
      const res = await pending;
      expect(res.status, label).toBe(404);
      expect((await problemOf(res)).code, label).toBe("ERR_NOT_FOUND");
    }

    // Inside ONE company: February's line named under January's path is not January's line.
    const [februaryLine] = (await linesOf(february)).items;
    const crossed = await matchLine(january, februaryLine!.id, {
      kind: "receipt",
      documentId: receiptId,
      amount: "1.0000",
    });
    expect(crossed.status).toBe(404);
    expect((await linesOf(february)).items[0]!.matchedAmount).toBe("0.0000");
  });

  // Why the unmatch answers 200 with the row and not the plan's 204: the idempotency layer replays a stored
  // answer with its stored body, and a 204 may carry none.
  it("a replayed unmatch answers the stored row and unmatches nothing a second time (§4.2.9)", async () => {
    const request = {
      method: "POST" as const,
      as: s.human,
      path: `${base()}/matches/${rematch}/unmatch`,
      idempotencyKey: "4b-bank-unmatch-replay",
      body: { reason: "replayed" },
    };
    const first = await api.request(request);
    expect(first.status).toBe(200);
    const replay = await api.request(request);
    expect(replay.status).toBe(200);
    expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
    const row = BankMatchSchema.parse(await first.json());
    expect(await replay.json()).toEqual(row);
    expect(row).toMatchObject({ id: rematch, unmatchReason: "replayed" });
  });

  it("a principal without accounting.bank.reconcile gets 403 on every sub-path", async () => {
    const requests: [string, "GET" | "POST", unknown][] = [
      [
        base(),
        "POST",
        { bankAccountId: bank, csv: JANUARY, mapping: mapping("2026-03-31", "0.0000", "600.0000") },
      ],
      [base(), "GET", undefined],
      [`${base()}/${january}/lines`, "GET", undefined],
      [
        `${base()}/${january}/lines/${receiptLine}/matches`,
        "POST",
        { kind: "receipt", documentId: receiptId, amount: { amount: "1.0000", currency: "MYR" } },
      ],
      [`${base()}/matches/${paymentMatch}/unmatch`, "POST", { reason: "sneak" }],
      [
        `${base()}/reconciliation?filter[bank_account_id][eq]=${bank}&filter[as_of][eq]=2026-01-31`,
        "GET",
        undefined,
      ],
    ];
    for (const [path, method, body] of requests) {
      const res = await api.request({ method, path, as: outsider, body });
      expect(res.status, `${method} ${path}`).toBe(403);
      const problem = await problemOf(res);
      expect(problem.code).toBe("ERR_RBAC_FORBIDDEN");
      expect(problem.detail).toMatch(/accounting\.bank\.reconcile/);
    }
  });
});
