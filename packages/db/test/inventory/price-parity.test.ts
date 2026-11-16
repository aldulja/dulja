import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { selectPrice, type PriceListCandidate, type PriceListLineCandidate } from "@dulja/domain";
import { createPriceList, replacePriceListLines, resolvePrice } from "../../src/inventory/prices";
import { grantCodes, seedBranch, seedItem, seedTenant, seedUnit, type Seed } from "../fixtures";
import { startDb, withTenant, type Db } from "../harness";

/**
 * POS-02: the till prices offline with `@dulja/domain`'s `selectPrice` and the server never re-prices a ticket,
 * so the pure function must answer what `resolvePrice`'s SQL answers. One catalogue, every combination of the
 * query's dimensions, both resolvers, the same line or the same "no price".
 */
describe("selectPrice answers exactly what the server's resolvePrice answers (POS-02)", () => {
  let db: Db;
  let a: Seed;
  let itemId: string;
  let baseUnitId: string;
  let cartonId: string;
  let branchId: string;
  let otherBranchId: string;

  beforeAll(async () => {
    db = await startDb();
    a = await seedTenant(db, "Price parity");
    await grantCodes(db, a);
    ({ itemId, baseUnitId } = await seedItem(db, a, { code: "PARITY-1" }));
    cartonId = await seedUnit(db, a, { code: "CTN", nameEn: "Carton" });
    branchId = await seedBranch(db, a, { code: "KL-01" });
    otherBranchId = await seedBranch(db, a, { code: "PG-01" });

    await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      const make = async (
        code: string,
        o: {
          currency?: string;
          customerKind?: string | null;
          branchId?: string | null;
          validFrom?: string | null;
          validTo?: string | null;
        },
        lines: { unitId?: string | null; minQuantity?: string; unitPrice: string }[],
      ) => {
        const l = await createPriceList(tx, {
          companyId: a.company,
          code,
          nameEn: code,
          currency: o.currency ?? "MYR",
          customerKind: o.customerKind ?? null,
          branchId: o.branchId ?? null,
          validFrom: o.validFrom ?? null,
          validTo: o.validTo ?? null,
        });
        await replacePriceListLines(
          tx,
          l.id,
          lines.map((n) => ({ itemId, ...n })),
        );
      };
      await make("AAA-USD", { currency: "USD" }, [{ unitPrice: "3.0000" }]);
      await make("AAB-WHOLE", { customerKind: "wholesale" }, [
        { unitPrice: "9.0000" },
        { minQuantity: "100", unitPrice: "8.0000" },
      ]);
      await make("RETAIL", { customerKind: "retail" }, [
        { unitPrice: "12.0000" },
        { minQuantity: "10", unitPrice: "11.0000" },
        { unitId: cartonId, unitPrice: "130.0000" },
      ]);
      await make("WALKIN", {}, [
        { unitPrice: "12.5000" },
        { unitId: baseUnitId, minQuantity: "1", unitPrice: "12.4000" },
        { minQuantity: "250", unitPrice: "10.0000" },
      ]);
      await make("WALKIN-B", {}, [{ unitPrice: "12.6000" }]);
      await make("KL", { branchId }, [{ minQuantity: "10", unitPrice: "11.5000" }]);
      await make("KL-WHOLE", { branchId, customerKind: "wholesale" }, [{ unitPrice: "8.5000" }]);
      await make("PG", { branchId: otherBranchId }, [{ unitPrice: "1.0000" }]);
      await make("SPRING", { validFrom: "2026-03-01", validTo: "2026-03-31" }, [
        { unitPrice: "11.9000" },
      ]);
    });
  });
  afterAll(async () => {
    await db.stop();
  });

  it("agrees on every query over currency, date, branch, trade level, unit and quantity", async () => {
    const { lists, lines } = await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      const listRows = await tx<PriceListCandidate[]>`
        select id, code, currency, customer_kind as "customerKind", branch_id as "branchId",
               valid_from::text as "validFrom", valid_to::text as "validTo"
          from app.price_list where company_id = ${a.company} and archived_at is null`;
      const lineRows = await tx<PriceListLineCandidate[]>`
        select n.id, n.price_list_id as "priceListId", n.item_id as "itemId", n.unit_id as "unitId",
               n.min_quantity::text as "minQuantity", n.unit_price::text as "unitPrice"
          from app.price_list_line n join app.price_list l on l.id = n.price_list_id
         where l.company_id = ${a.company} and n.archived_at is null`;
      return { lists: [...listRows], lines: [...lineRows] };
    });

    let compared = 0;
    let priced = 0;
    for (const currency of ["MYR", "USD", "EUR"])
      for (const on of ["2026-02-28", "2026-03-01", "2026-03-31", "2026-04-01"])
        for (const branch of [null, branchId, otherBranchId])
          for (const customerKind of [null, "retail", "wholesale"])
            for (const unitId of [null, baseUnitId, cartonId])
              for (const quantity of [
                "0.500000",
                "1.000000",
                "10.000000",
                "100.000000",
                "250.000000",
              ]) {
                const q = {
                  itemId,
                  currency,
                  on,
                  unitId,
                  customerKind,
                  branchId: branch,
                  quantity,
                };
                const server = await withTenant(db.rw, a.tenant, a.human, (tx) =>
                  resolvePrice(tx, { companyId: a.company, ...q }),
                );
                const pure = selectPrice(lists, lines, q);
                expect({
                  q,
                  line: pure?.line.id ?? null,
                  price: pure?.line.unitPrice ?? null,
                }).toEqual({
                  q,
                  line: server?.priceListLineId ?? null,
                  price: server?.unitPrice ?? null,
                });
                compared += 1;
                if (server !== null) priced += 1;
              }
    expect(compared).toBe(3 * 4 * 3 * 3 * 3 * 5);
    expect(priced).toBeGreaterThan(100); // the matrix is not vacuous
  });
});
