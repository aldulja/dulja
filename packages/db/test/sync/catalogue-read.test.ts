// packages/db/test/sync/catalogue-read.test.ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readCatalogue } from "../../src/sync/catalogue";
import { withTenant as prodWithTenant } from "../../src/with-tenant";
import { startDb, withTenant, type Db } from "../harness";
import {
  grantCodes,
  seedBranch,
  seedBranchPosPolicy,
  seedCashier,
  seedEmployee,
  seedItem,
  seedParty,
  seedPriceList,
  seedTaxCode,
  seedTenantV2,
  seedTerminal,
  seedUnit,
  type Seed,
} from "../fixtures";

describe("readCatalogue (§4.10.2) — branch-scoped, revision-ordered, resumable", () => {
  let db: Db;
  let s: Seed;
  let other: string;
  let hqTerminal: { terminalId: string; principalId: string };
  beforeAll(async () => {
    db = await startDb();
    s = await seedTenantV2(db, "Alpha");
    await grantCodes(db, s);
    other = await seedBranch(db, s, { code: "BR2", nameEn: "Branch 2" });
    hqTerminal = await seedTerminal(db, s, { code: "T-HQ" });
  }, 180_000);
  afterAll(async () => {
    await db.stop();
  });

  const read = (since: bigint, limit: number, branchId = s.hq) =>
    prodWithTenant(
      db.rw,
      { tenantId: s.tenant, actorId: hqTerminal.principalId, requestId: "cat" },
      (tx) => readCatalogue(tx, { companyId: s.company, branchId, since, limit }),
    );

  it("returns every stream a terminal needs, ordered by revision, with a usable next cursor", async () => {
    const unitId = await seedUnit(db, s);
    await seedItem(db, s, { code: "SKU-A", baseUnitId: unitId });
    await seedParty(db, s, { code: "CUST-A" });
    await seedPriceList(db, s, { code: "PL-HQ", branchId: s.hq });

    const page = await read(0n, 1000);
    expect(page.changes.length).toBeGreaterThanOrEqual(3);
    expect(page.changes.map((c) => c.revision)).toEqual(
      page.changes.map((c) => c.revision).toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    );
    expect(new Set(page.changes.map((c) => c.stream))).toEqual(
      new Set(["item", "customer", "price_list"]),
    );
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBe(page.changes.at(-1)!.revision);
  });

  it("paging by the cursor visits every row exactly once — the property acceptance test 20 rests on", async () => {
    const unitId = await seedUnit(db, s);
    for (let i = 0; i < 25; i += 1)
      await seedItem(db, s, { code: `SKU-P${i}`, baseUnitId: unitId });

    const seen: string[] = [];
    let cursor = 0n;
    let guard = 0;
    for (;;) {
      const page = await read(cursor, 4);
      for (const ch of page.changes) seen.push(`${ch.stream}:${ch.id}:${ch.op}`);
      cursor = page.nextCursor;
      if (!page.hasMore) break;
      if ((guard += 1) > 100) throw new Error("pagination did not terminate");
    }
    expect(new Set(seen).size, "no row is delivered twice").toBe(seen.length);
    const whole = await read(0n, 1000);
    expect(seen.length).toBe(whole.changes.length);
  });

  it("paging is ordered by the BIGINT revision and not its text — the 9 → 10 digit boundary", async () => {
    // The regression this case pins: in a set operation PostgreSQL resolves ORDER BY against the OUTPUT
    // column list, so `order by revision` beside `revision::text as revision` sorts lexicographically and
    // "10" < "2" < "9". A first page of four would then be 1, 10, 11, 12 and revisions 2..9 would be
    // unreachable for ever. Asserting the page's own ordering is not enough — a lexicographic page is
    // internally consistent — so this asserts the CONTENT of the first page against the numeric order.
    const whole = await read(0n, 1000);
    const numeric = whole.changes.toSorted((a, b) =>
      a.revision < b.revision ? -1 : a.revision > b.revision ? 1 : 0,
    );
    // The corpus above already spans one, two and (with 25 items) two-digit revisions; assert it really does,
    // or the case is vacuous on a fresh database.
    expect(
      numeric.filter((c) => c.revision < 10n).length,
      "the corpus must span the boundary",
    ).toBeGreaterThan(1);
    expect(numeric.filter((c) => c.revision >= 10n).length).toBeGreaterThan(1);

    const first = await read(0n, 4);
    expect(first.changes.map((c) => c.revision)).toEqual(
      numeric.slice(0, 4).map((c) => c.revision),
    );
    expect(first.nextCursor).toBe(numeric[3]!.revision);
  });

  it("an archived price-list LINE arrives as a delete and never again as an upsert", async () => {
    const unitId = await seedUnit(db, s);
    const { itemId } = await seedItem(db, s, { code: "SKU-LN", baseUnitId: unitId });
    const plId = await seedPriceList(db, s, { code: "PL-LN", branchId: s.hq });
    const lineId = await withTenant(db.rw, s.tenant, s.human, async (tx) => {
      const [row] = await tx<{ id: string }[]>`
        insert into app.price_list_line (tenant_id, price_list_id, item_id, min_quantity, unit_price)
        values (${s.tenant}, ${plId}, ${itemId}, 0, 4.5000) returning id`;
      return row!.id;
    });
    const before = (await read(0n, 1000)).nextCursor;
    await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx`update app.price_list_line set archived_at = now() where id = ${lineId}`,
    );

    const page = await read(before, 1000);
    const forLine = page.changes.filter((c) => c.id === lineId);
    // Exactly ONE change: the tombstone. Without `l.archived_at is null` in the live leg the archived row
    // would ALSO arrive as an upsert at the same revision, and the till would apply them in an order nothing
    // fixes — a coin flip between "deleted" and "still priced".
    expect(forLine).toHaveLength(1);
    expect(forLine[0]!.op).toBe("delete");
    expect(forLine[0]!.stream).toBe("price_list_line");
  });

  it("a promotion is delivered whatever its window, and its retirement is an upsert (3A has no archived_at)", async () => {
    const promoId = await withTenant(db.rw, s.tenant, s.human, async (tx) => {
      const [row] = await tx<{ id: string }[]>`
        insert into app.promotion (tenant_id, company_id, code, name_en, kind, definition, starts_at, ends_at)
        values (${s.tenant}, ${s.company}, 'PROMO-CAT', 'Ten off', 'percent_off', ${tx.json({ percent: 10 })},
                now() - interval '1 day', now() + interval '30 days')
        returning id`;
      return row!.id;
    });
    expect(
      (await read(0n, 1000)).changes.some((c) => c.stream === "promotion" && c.id === promoId),
    ).toBe(true);

    const before = (await read(0n, 1000)).nextCursor;
    await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) =>
        tx`update app.promotion set ends_at = now() - interval '1 second' where id = ${promoId}`,
    );
    const page = await read(before, 1000);
    const change = page.changes.find((c) => c.id === promoId);
    // An UPSERT carrying the shortened window, not a delete and not an absence. The till's own window check
    // retires it; the server filtering by `ends_at` here would leave every till holding the OLD window.
    expect(change).toBeDefined();
    expect(change!.op).toBe("upsert");
    expect((change!.row as { ends_at: string }).ends_at).toBeTruthy();
  });

  it("scopes to the terminal's branch: another branch's price list is absent, a company-wide one is present", async () => {
    await seedPriceList(db, s, { code: "PL-BR2", branchId: other });
    await seedPriceList(db, s, { code: "PL-ALL" }); // branch_id null = every branch (§4.5.6 Form B)
    const page = await read(0n, 1000);
    const codes = page.changes
      .filter((c) => c.stream === "price_list")
      .map((c) => (c.row as { code: string }).code);
    expect(codes).toContain("PL-ALL");
    expect(codes).toContain("PL-HQ");
    expect(codes).not.toContain("PL-BR2");
  });

  it("an archived row arrives as a DELETE and never as an absence (spec:1300)", async () => {
    const plId = await seedPriceList(db, s, { code: "PL-DEAD", branchId: s.hq });
    const before = (await read(0n, 1000)).nextCursor;
    await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx`update app.price_list set archived_at = now() where id = ${plId}`,
    );
    const page = await read(before, 1000);
    const tomb = page.changes.find((c) => c.id === plId);
    expect(tomb).toBeDefined();
    expect(tomb!.op).toBe("delete");
    expect(tomb!.row).toBeNull();
    // And exactly one change for that row in this window — the tombstone, not an upsert AND a tombstone.
    expect(page.changes.filter((c) => c.id === plId)).toHaveLength(1);
  });

  it("the two 6C streams are empty when no credentials or policies have been configured", async () => {
    const page = await read(0n, 1000);
    expect(
      page.changes.filter((c) => c.stream === "cashier" || c.stream === "branch_pos_policy"),
    ).toEqual([]);
  });
  it("delivers live 6C credentials and exact policy limits through the same resumable stream", async () => {
    const since = (await read(0n, 1000)).nextCursor;
    const employeeId = await seedEmployee(db, s, { employeeNumber: "CAT-EMPLOYEE" });
    const cashierId = await seedCashier(db, s, { employeeId, branchId: s.hq });
    const policyId = await seedBranchPosPolicy(db, s, {
      limits: { maxCashInDrawer: "900719925474.0993", maxLineDiscountPct: "0.123456" },
    });
    const otherEmployee = await seedEmployee(db, s, { employeeNumber: "CAT-OTHER" });
    const otherCashier = await seedCashier(db, s, { employeeId: otherEmployee, branchId: other });
    const otherPolicy = await seedBranchPosPolicy(db, s, { branchId: other });
    const whole = await read(since, 1000);
    const cashier = whole.changes.find((c) => c.stream === "cashier" && c.id === cashierId);
    expect(cashier?.row).toMatchObject({
      employee_number: "CAT-EMPLOYEE",
      revision: String(cashier!.revision),
    });
    const policy = whole.changes.find((c) => c.stream === "branch_pos_policy" && c.id === policyId);
    expect(policy?.row).toMatchObject({
      max_cash_in_drawer: "900719925474.0993",
      max_line_discount_pct: "0.123456",
      revision: String(policy!.revision),
    });
    expect(whole.changes.some((c) => c.id === otherCashier || c.id === otherPolicy)).toBe(false);
    const seen: string[] = [];
    let cursor = since;
    for (let guard = 0; guard < 20; guard += 1) {
      const page = await read(cursor, 1);
      seen.push(...page.changes.map((c) => c.id));
      cursor = page.nextCursor;
      if (!page.hasMore) break;
      if (guard === 19) throw new Error("6C pagination did not finish");
    }
    expect(seen).toEqual(whole.changes.map((c) => c.id));
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("keeps catalogue decimal values and embedded revisions as exact strings", async () => {
    await db.admin`select setval('app.catalogue_revision_seq', ${"9007199254740993"}::bigint)`;
    const partyId = await seedParty(db, s, { code: "CUST-PRECISE" });
    const { taxCodeId } = await seedTaxCode(db, s, {
      code: "TAX-PRECISE",
      kind: "zero",
      rate: "0.00000000",
    });
    await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) =>
        tx`insert into app.promotion (tenant_id, company_id, code, name_en, kind, definition) values (${s.tenant}, ${s.company}, 'PROMO-PRECISE', 'Exact amount', 'amount_off', '{"itemIds": [], "amountPerUnit": 900719925474.0993, "currency": "MYR"}'::jsonb)`,
    );
    await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx`update app.party set credit_limit = 900719925474.0993 where id = ${partyId}`,
    );
    const unitId = await seedUnit(db, s);
    const { itemId } = await seedItem(db, s, { code: "SKU-PRECISE", baseUnitId: unitId });
    const priceListId = await seedPriceList(db, s, { code: "PL-PRECISE" });
    const lineId = await withTenant(db.rw, s.tenant, s.human, async (tx) => {
      const [row] = await tx<{ id: string }[]>`
        insert into app.price_list_line (tenant_id, price_list_id, item_id, min_quantity, unit_price)
        values (${s.tenant}, ${priceListId}, ${itemId}, 1.000001, 900719925474.0993) returning id`;
      return row!.id;
    });
    const page = await read(0n, 1000);
    const change = page.changes.find((ch) => ch.id === lineId)!;
    expect(change.row?.["unit_price"]).toBe("900719925474.0993");
    expect(change.row?.["min_quantity"]).toBe("1.000001");
    expect(
      page.changes.find((ch) => ch.stream === "promotion" && ch.row?.["code"] === "PROMO-PRECISE")
        ?.row?.["definition"],
    ).toMatchObject({ amountPerUnit: "900719925474.0993" });
    expect(change.revision).toBeGreaterThan(9007199254740993n);
    expect(change.row?.["revision"]).toBe(change.revision.toString());
    expect(page.changes.find((ch) => ch.id === partyId)?.row?.["credit_limit"]).toBe(
      "900719925474.0993",
    );
    expect(page.changes.find((ch) => ch.id === taxCodeId)?.row?.["rate"]).toBe("0.00000000");
  });
});
