// packages/db/test/ar-ap/control-account.test.ts — code review 2026-09-29: a party's control account has ONE
// definition (app.party_control_account, 0045). Allocation and partyBalance used to read receivable-or-payable
// strictly by kind while the ageing, the tie-out and the revaluation fell back to the other account, so an
// employee with only a payable account showed an open item the ageing aged and allocation refused to settle.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Money, currency } from "@dulja/domain";
import type { Sql } from "postgres";
import { allocateSettlement, openBalance, partyBalance } from "../../src/ar-ap/allocation";
import { ageingRows, ageingTieOut } from "../../src/ar-ap/ageing";
import { withTenant, type TenantContext } from "../../src/with-tenant";
import { seedParty, seedTenantV2, startDb, uuidv7, type Db, type Seed } from "../index";
import {
  arApFixture,
  postFromPack,
  type ArApFixture,
} from "../../../../tests/invariants/support/ar-ap";

let db: Db;
let s: Seed;
let f: ArApFixture;
const MYR = currency("MYR");

const as = async <T>(fn: (tx: Sql, c: TenantContext) => Promise<T>): Promise<T> => {
  const c = { tenantId: s.tenant, actorId: s.human, requestId: await uuidv7(db.admin) };
  return withTenant(db.rw, c, (tx) => fn(tx, c));
};

/** A party of `kind` whose two control columns are exactly `receivable` / `payable` (seedParty sets both). */
const partyWith = async (
  kind: "customer" | "vendor" | "employee",
  code: string,
  receivable: string | null,
  payable: string | null,
): Promise<string> => {
  const id = await seedParty(db, s, { kind, code });
  await as(
    (
      tx,
    ) => tx`update app.party set receivable_account_id = ${receivable}, payable_account_id = ${payable}
                where id = ${id}`,
  );
  return id;
};

beforeAll(async () => {
  db = await startDb();
  s = await seedTenantV2(db, "control-account");
  f = await arApFixture(db, s);
}, 300_000);
afterAll(async () => {
  await db?.stop();
});

describe("app.party_control_account — one definition for every open-item reader", () => {
  it("picks payable for a vendor and receivable otherwise, each falling back to the other", async () => {
    const ar = f.accountIds["1200"]!;
    const ap = f.accountIds["2100"]!;
    const cases: [Parameters<typeof partyWith>[0], string | null, string | null, string | null][] =
      [
        ["vendor", ar, ap, ap],
        ["vendor", ar, null, ar],
        ["customer", ar, ap, ar],
        ["customer", null, ap, ap],
        ["employee", null, ap, ap],
        ["employee", null, null, null],
      ];
    for (const [i, [kind, receivable, payable, expected]] of cases.entries()) {
      const id = await partyWith(kind, `CA-${i}`, receivable, payable);
      const [row] = await as(
        (tx) => tx<{ got: string | null }[]>`
          select app.party_control_account(p)::text as got from app.party p where p.id = ${id}`,
      );
      expect(row!.got, `${kind} r=${receivable !== null} p=${payable !== null}`).toBe(expected);
    }
  });

  it("an employee with only a payable account: the ageing, partyBalance and allocation agree", async () => {
    const employee = await partyWith("employee", "EMP-1", null, f.accountIds["2100"]!);
    const claim = await postFromPack(db, s, {
      code: "PURCHASE_INVOICE",
      effectiveDate: "2026-01-10",
      partyId: employee,
      lines: [{ kind: "account", accountId: f.accountIds["5900"]!, amount: "300.0000" }],
    });
    const payment = await postFromPack(db, s, {
      code: "PAYMENT",
      effectiveDate: "2026-01-20",
      partyId: employee,
      lines: [{ kind: "account", accountId: f.accountIds["1100"]!, amount: "300.0000" }],
    });

    // The ageing ages the claim on 2100 (an employee is not flipped, so it reads as a credit) …
    const aged = await as((tx) => ageingRows(tx, { companyId: s.company, asOf: "2026-01-15" }));
    expect(aged.filter((r) => r.partyId === employee).map((r) => r.amount)).toEqual(["-300.0000"]);
    // … partyBalance reads the same account (it read the NULL receivable and said 0) …
    const bal = await as((tx) =>
      partyBalance(tx, { companyId: s.company, partyId: employee, asOf: "2026-01-15" }),
    );
    expect(bal.base.toString()).toBe("-300.0000");

    // … and the tie-out reconciles it (code review 2, F3): the ageing reports the employee un-flipped, so the
    // tie-out brings each party back to debit-positive by the same kind test before orienting by the
    // account's type. It read ageing −300 against a ledger of 300 on 2100 — a difference of −600.0000.
    const tied = await as((tx) => ageingTieOut(tx, { companyId: s.company, asOf: "2026-01-15" }));
    expect(tied.find((r) => r.accountCode === "2100")).toMatchObject({
      ageingBase: "300.0000",
      ledgerBase: "300.0000",
      difference: "0.0000",
    });
    expect(tied.map((r) => [r.accountCode, r.difference])).toEqual(
      tied.map((r) => [r.accountCode, "0.0000"]),
    );

    // … and allocation settles it (it refused: "does not move its party's control account").
    await as((tx, c) =>
      allocateSettlement(tx, c, {
        companyId: s.company,
        settlementDocumentId: payment.documentId,
        lines: [{ settledDocumentId: claim.documentId, amount: Money.of("300.0000", MYR) }],
      }),
    );
    const open = await as((tx) =>
      openBalance(tx, { companyId: s.company, documentId: claim.documentId }),
    );
    expect(open.document.toString()).toBe("0.0000");
    const after = await as((tx) => ageingRows(tx, { companyId: s.company, asOf: "2026-01-31" }));
    expect(after.filter((r) => r.partyId === employee && r.amount !== "0.0000")).toEqual([]);
    const settled = await as((tx) =>
      ageingTieOut(tx, { companyId: s.company, asOf: "2026-01-31" }),
    );
    expect(settled.map((r) => [r.accountCode, r.difference])).toEqual(
      settled.map((r) => [r.accountCode, "0.0000"]),
    );
  });

  // Code review 2 (F3), the mirror case: a vendor with only a receivable account sits on 1200 (an asset) while
  // the ageing flips it as a vendor, so the tie-out read ageing −50 against a ledger of 50 — a difference of
  // −100.0000 — for as long as the item was open. The ageing's own per-kind sign (§4.8.2's "vendor side
  // sign-flipped") is frozen and is left as it is; only the tie-out undoes it, per party.
  it("a vendor with only a receivable account: the ageing is kind-flipped and the tie-out still reconciles 1200", async () => {
    const vendor = await partyWith("vendor", "VND-AR-1", f.accountIds["1200"]!, null);
    const sale = await postFromPack(db, s, {
      code: "SALES_INVOICE",
      effectiveDate: "2026-01-10",
      partyId: vendor,
      lines: [{ kind: "account", accountId: f.accountIds["4000"]!, amount: "50.0000" }],
    });
    const aged = await as((tx) => ageingRows(tx, { companyId: s.company, asOf: "2026-01-15" }));
    expect(aged.filter((r) => r.partyId === vendor).map((r) => r.amount)).toEqual(["-50.0000"]);
    const open = await as((tx) => ageingTieOut(tx, { companyId: s.company, asOf: "2026-01-15" }));
    expect(open.find((r) => r.accountCode === "1200")).toMatchObject({
      ageingBase: "50.0000",
      ledgerBase: "50.0000",
      difference: "0.0000",
    });
    expect(open.map((r) => [r.accountCode, r.difference])).toEqual(
      open.map((r) => [r.accountCode, "0.0000"]),
    );

    await postFromPack(db, s, {
      code: "RECEIPT",
      effectiveDate: "2026-01-20",
      partyId: vendor,
      lines: [{ kind: "account", accountId: f.accountIds["1100"]!, amount: "50.0000" }],
      allocate: [{ settledDocumentId: sale.documentId, amount: Money.of("50.0000", MYR) }],
    });
    const settled = await as((tx) =>
      ageingTieOut(tx, { companyId: s.company, asOf: "2026-01-31" }),
    );
    expect(settled.map((r) => [r.accountCode, r.difference])).toEqual(
      settled.map((r) => [r.accountCode, "0.0000"]),
    );
  });
});
