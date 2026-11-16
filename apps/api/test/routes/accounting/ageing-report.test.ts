import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AgeingList, encodeCursor, ReportCodeSchema } from "@dulja/contracts";
import { Money, currency } from "@dulja/domain";
import { withTenant } from "@dulja/db";
import { grantCodes, seedTenantV2, uuidv7, type Seed } from "@dulja/db/test";
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
 * `GET /v1/companies/{companyId}/reports/accounting.ageing` — 4B Task 3's one route: a GET on 1B's reports
 * module over `agedBalance`, filtered through `parseFilters` (§4.2.8 Layer 2).
 */
const MYR = currency("MYR");

const pathOf = (companyId: string, query: string) =>
  `/v1/companies/${companyId}/reports/accounting.ageing?${query}`;
const items = async (res: Response) => AgeingList.parse(await res.json());

describe("GET …/reports/accounting.ageing (§4.16.1, §4.8.2)", () => {
  let api: StartedApi;
  let s: Seed;
  let f: ArApFixture;
  let clerk: string;
  let sibling: string;

  const get = (query: string, as: string = s.human, companyId = s.company) =>
    api.request({ method: "GET", path: pathOf(companyId, query), as });

  beforeAll(async () => {
    api = await startApi();
    s = await seedTenantV2(api.db, "AgeingReport");
    f = await arApFixture(api.db, s);
    // `arApFixture` grants the posting codes; the report's gate is `accounting.report.read`.
    await grantCodes(api.db, s, { codes: ["accounting.report.read"], roleCode: "ageing-reader" });
    // A principal of the same tenant with no report code, and a sibling company the reader holds nothing in.
    clerk = await secondPrincipal(api.db, s, "ageing-clerk");
    await grantCodes(api.db, s, {
      codes: ["accounting.receipt.create"],
      principalId: clerk,
      roleCode: "ageing-clerk",
    });
    sibling = await uuidv7(api.db.admin);
    await withTenant(
      api.db.migrator,
      { tenantId: s.tenant, actorId: s.system, requestId: await uuidv7(api.db.admin) },
      (tx) => tx`
        insert into app.company (id, tenant_id, code, name, base_currency)
        values (${sibling}, ${s.tenant}, 'SIB', 'Sibling company', 'MYR')`,
    );

    const line = (code: string, amount: string) => ({
      kind: "account" as const,
      accountId: f.accountIds[code]!,
      amount,
    });
    // As of 2026-04-30 on the fixture's 30-day term: 1000 current, 400 − 250 = 150 in 61_90, 750 current.
    await postFromPack(api.db, s, {
      code: "SALES_INVOICE",
      effectiveDate: "2026-04-15",
      partyId: f.partyIds.customer,
      lines: [line("4000", "1000.0000")],
    });
    const { documentId: old } = await postFromPack(api.db, s, {
      code: "SALES_INVOICE",
      effectiveDate: "2026-01-01",
      partyId: f.partyIds.customer,
      lines: [line("4000", "400.0000")],
    });
    await postFromPack(api.db, s, {
      code: "RECEIPT",
      effectiveDate: "2026-04-25",
      partyId: f.partyIds.customer,
      lines: [line("1100", "250.0000")],
      allocate: [{ settledDocumentId: old, amount: Money.of("250.0000", MYR) }],
    });
    await postFromPack(api.db, s, {
      code: "PURCHASE_INVOICE",
      effectiveDate: "2026-04-20",
      partyId: f.partyIds.vendor,
      lines: [line("5900", "750.0000")],
    });
  }, 600_000);
  afterAll(async () => {
    await api.stop();
  });

  it("answers the pivoted buckets per party and currency, in the registered row shape", async () => {
    const res = await get("filter[as_of][eq]=2026-04-30");
    expect(res.status).toBe(200);
    const body = await items(res);
    expect(body.next_cursor).toBeNull();
    expect(body.items.map((r) => [r.partyCode, r.partyKind, r.currency])).toEqual([
      ["CUST-1", "customer", "MYR"],
      ["VEND-1", "vendor", "MYR"],
    ]);
    expect(body.items[0]).toMatchObject({
      partyId: f.partyIds.customer,
      current: "1000.0000",
      d1_30: "0.0000",
      d31_60: "0.0000",
      d61_90: "150.0000",
      over_90: "0.0000",
      total: "1150.0000",
      totalBase: "1150.0000",
    });
    expect(body.items[1]).toMatchObject({ current: "750.0000", total: "750.0000" });
  });

  it("reconciles to the ledger to the cent: Σ customer totalBase is 1200's balance, Σ vendor totalBase 2100's negated", async () => {
    const body = await items(await get("filter[as_of][eq]=2026-04-30"));
    const sum = (kind: string) =>
      body.items
        .filter((r) => r.partyKind === kind)
        .reduce((acc, r) => acc.add(Money.of(r.totalBase, MYR)), Money.zero(MYR));
    const ledger = await withTenant(
      api.db.rw,
      { tenantId: s.tenant, actorId: s.human, requestId: await uuidv7(api.db.admin) },
      (tx) => tx<{ code: string; net: string }[]>`
        select a.code, sum(l.base_debit - l.base_credit)::numeric(19,4)::text as net
          from app.ledger_entry l join app.account a on a.id = l.account_id
         where l.company_id = ${s.company} and a.code in ('1200', '2100')
           and l.effective_date <= '2026-04-30'
         group by a.code order by a.code`,
    );
    const net = new Map(ledger.map((r) => [r.code, Money.of(r.net, MYR)]));
    expect(sum("customer").toString()).toBe(net.get("1200")!.toString());
    expect(sum("vendor").toString()).toBe(net.get("2100")!.negate().toString());
  });

  it("filters by party, party kind, currency and bucket (eq and in)", async () => {
    const vendors = await items(
      await get("filter[as_of][eq]=2026-04-30&filter[party_kind][eq]=vendor"),
    );
    expect(vendors.items.map((r) => r.partyId)).toEqual([f.partyIds.vendor]);

    const one = await items(
      await get(`filter[as_of][eq]=2026-04-30&filter[party_id][eq]=${f.partyIds.customer}`),
    );
    expect(one.items.map((r) => r.partyId)).toEqual([f.partyIds.customer]);

    const eur = await items(await get("filter[as_of][eq]=2026-04-30&filter[currency][eq]=EUR"));
    expect(eur.items).toEqual([]);

    const old = await items(await get("filter[as_of][eq]=2026-04-30&filter[bucket][eq]=61_90"));
    expect(old.items.map((r) => [r.partyCode, r.d61_90, r.current, r.total])).toEqual([
      ["CUST-1", "150.0000", "0.0000", "150.0000"],
    ]);

    const both = await items(
      await get("filter[as_of][eq]=2026-04-30&filter[bucket][in]=61_90,over_90"),
    );
    expect(both.items.map((r) => r.partyCode)).toEqual(["CUST-1"]);

    // An earlier date sees an earlier ledger: as of 2026-01-31 only the January invoice exists, not yet due.
    const january = await items(await get("filter[as_of][eq]=2026-01-31"));
    expect(january.items.map((r) => [r.partyCode, r.current, r.total])).toEqual([
      ["CUST-1", "400.0000", "400.0000"],
    ]);
  });

  it("keysets on (party_code, currency): a full page carries a cursor, the last page none", async () => {
    const first = await items(await get("filter[as_of][eq]=2026-04-30&limit=1"));
    expect(first.items.map((r) => r.partyCode)).toEqual(["CUST-1"]);
    expect(first.next_cursor).not.toBeNull();
    const second = await items(
      await get(`filter[as_of][eq]=2026-04-30&limit=1&cursor=${first.next_cursor!}`),
    );
    expect(second.items.map((r) => r.partyCode)).toEqual(["VEND-1"]);
    const third = await items(
      await get(`filter[as_of][eq]=2026-04-30&limit=1&cursor=${second.next_cursor!}`),
    );
    expect(third).toEqual({ items: [], next_cursor: null });
  });

  it.each([
    ["no as_of at all", "limit=10", "filter[as_of][eq]"],
    [
      "an impossible date postgres.js would roll over",
      "filter[as_of][eq]=2026-02-30",
      "filter[as_of][eq]",
    ],
    ["an operator as_of does not take", "filter[as_of][lt]=2026-04-30", "filter[as_of][lt]"],
    [
      "an undeclared field",
      "filter[as_of][eq]=2026-04-30&filter[amount][gt]=1",
      "filter[amount][gt]",
    ],
    ["a flat parameter §4.2.8 Layer 1 forbids", "asOf=2026-04-30", "asOf"],
    [
      "a key outside the filter grammar",
      "filter[as_of][eq]=2026-04-30&filter[Party_Kind][eq]=vendor",
      "filter[Party_Kind][eq]",
    ],
    [
      "a clause given twice",
      "filter[as_of][eq]=2026-04-30&filter[as_of][eq]=2026-03-31",
      "filter[as_of][eq]",
    ],
    [
      "two clauses on one field",
      "filter[as_of][eq]=2026-04-30&filter[bucket][eq]=current&filter[bucket][in]=1_30",
      "filter[bucket][in]",
    ],
    [
      "an unknown bucket",
      "filter[as_of][eq]=2026-04-30&filter[bucket][in]=current,90_plus",
      "filter[bucket][in]",
    ],
    [
      "a malformed party id",
      "filter[as_of][eq]=2026-04-30&filter[party_id][eq]=CUST-1",
      "filter[party_id][eq]",
    ],
    [
      "an unknown party kind",
      "filter[as_of][eq]=2026-04-30&filter[party_kind][eq]=supplier",
      "filter[party_kind][eq]",
    ],
    [
      "a currency with in",
      "filter[as_of][eq]=2026-04-30&filter[currency][in]=MYR,EUR",
      "filter[currency][in]",
    ],
  ])("refuses %s with ERR_VALIDATION_FAILED naming the key", async (_label, query, key) => {
    const res = await get(query);
    expect(res.status).toBe(400);
    const problem = await problemOf(res);
    expect(problem.code).toBe("ERR_VALIDATION_FAILED");
    expect(problem.errors?.map((e) => e.path)).toEqual([key]);
  });

  it("refuses a cursor that is not this report's keyset", async () => {
    const wrong = encodeCursor({ k: ["CUST-1"], id: f.partyIds.customer });
    const res = await get(`filter[as_of][eq]=2026-04-30&cursor=${wrong}`);
    expect(res.status).toBe(400);
    expect((await problemOf(res)).code).toBe("ERR_VALIDATION_FAILED");
  });

  it("is gated by accounting.report.read on the PATH company", async () => {
    const forbidden = await get("filter[as_of][eq]=2026-04-30", clerk);
    expect(forbidden.status).toBe(403);
    expect((await problemOf(forbidden)).code).toBe("ERR_RBAC_FORBIDDEN");
    // The reader's grant is on the seed company; the sibling company's report is not theirs to read.
    const sib = await get("filter[as_of][eq]=2026-04-30", s.human, sibling);
    expect(sib.status).toBe(403);
  });

  it("another tenant's reader cannot see this company's ageing (test 12)", async () => {
    const other = await seedTenantV2(api.db, "AgeingOther");
    await grantCodes(api.db, other, {
      codes: ["accounting.report.read"],
      roleCode: "other-reader",
    });
    const res = await get("filter[as_of][eq]=2026-04-30", other.human);
    expect([403, 404]).toContain(res.status);
  });
});

describe("the ageing report code (container-free)", () => {
  it("ReportCodeSchema admits accounting.ageing", () => {
    expect(ReportCodeSchema.options).toContain("accounting.ageing");
  });
});
