// packages/db/test/ar-ap/code-review-reverse.test.ts — code review 2026-09-29, the follow-up to B1: an
// allocation is live in the ageing on [effective_date, unallocated_on). A document whose allocation was
// withdrawn after its period closed (unallocated_on moved to the first open day) could still be reversed on a
// date inside that window once the period was reopened: the reversal nets the document from its own date
// while the withdrawn allocation still counts until unallocated_on, so the ageing stopped tying to 1200.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import { Money, currency } from "@dulja/domain";
import { ageingTieOut } from "../../src/ar-ap/ageing";
import { allocateSettlement, listAllocations, unallocate } from "../../src/ar-ap/allocation";
import { reverseDocument } from "../../src/posting";
import { withTenant, type TenantContext } from "../../src/with-tenant";
import { seedTenantV2, startDb, uuidv7, type Db, type Seed } from "../index";
import {
  arApFixture,
  postFromPack,
  type ArApFixture,
} from "../../../../tests/invariants/support/ar-ap";
import { recordingJobs } from "../../../../tests/invariants/support/post-inventory";

let db: Db;
let s: Seed;
let f: ArApFixture;
const MYR = currency("MYR");

const as = async <T>(fn: (tx: Sql, c: TenantContext) => Promise<T>): Promise<T> => {
  const c = { tenantId: s.tenant, actorId: s.human, requestId: await uuidv7(db.admin) };
  return withTenant(db.rw, c, (tx) => fn(tx, c));
};
const setMarch = async (status: "open" | "closed") =>
  withTenant(
    db.migrator,
    { tenantId: s.tenant, actorId: s.system, requestId: await uuidv7(db.admin) },
    (tx) => tx`
      update app.fiscal_period
         set status = ${status},
             reopen_reason = ${status === "open" ? "correct a reversal" : null}
       where company_id = ${s.company} and starts_on = '2026-03-01'::date`,
  );
const tie = async (asOf: string) =>
  (await as((tx) => ageingTieOut(tx, { companyId: s.company, asOf }))).find(
    (r) => r.accountCode === "1200",
  )!.difference;
const reverse = (documentId: string, effectiveDate: string) =>
  as((tx, c) =>
    reverseDocument(tx, c, { documentId, effectiveDate, reason: "review", jobs: recordingJobs() }),
  );

beforeAll(async () => {
  db = await startDb();
  s = await seedTenantV2(db, "code-review-reverse");
  f = await arApFixture(db, s);
}, 300_000);
afterAll(async () => {
  await db?.stop();
});

describe("a reversal is never dated inside a withdrawn allocation's live window", () => {
  it("refuses a reversal before unallocated_on, and one on or after it ties at every date", async () => {
    const post = async (code: string, on: string, accountCode: string) =>
      (
        await postFromPack(db, s, {
          code,
          effectiveDate: on,
          partyId: f.partyIds.customer,
          lines: [{ kind: "account", accountId: f.accountIds[accountCode]!, amount: "100.0000" }],
        })
      ).documentId;
    const invoiceId = await post("SALES_INVOICE", "2026-03-10", "4000");
    const receiptId = await post("RECEIPT", "2026-03-20", "1100");
    await as((tx, c) =>
      allocateSettlement(tx, c, {
        companyId: s.company,
        settlementDocumentId: receiptId,
        lines: [{ settledDocumentId: invoiceId, amount: Money.of("100.0000", MYR) }],
      }),
    );

    // March closes; the allocation is withdrawn in April, so it stays live until 1 April.
    await setMarch("closed");
    await as(async (tx, c) => {
      const [live] = await listAllocations(tx, {
        companyId: s.company,
        settlementDocumentId: receiptId,
      });
      await unallocate(tx, c, {
        companyId: s.company,
        settlementDocumentId: receiptId,
        allocationId: live!.id,
        reason: "applied to the wrong invoice",
      });
    });
    const [row] = await db.admin<{ on: string }[]>`
      select to_char(unallocated_on, 'YYYY-MM-DD') as on from app.allocation
       where settlement_document_id = ${receiptId}`;
    expect(row!.on).toBe("2026-04-01");

    // March is reopened to correct something; a reversal of the invoice dated 25 March would net it from
    // 25 March while the allocation still paid it until 1 April — refused.
    await setMarch("open");
    await expect(reverse(invoiceId, "2026-03-25")).rejects.toMatchObject({
      code: "ERR_VALIDATION_FAILED",
    });
    expect(await tie("2026-03-28")).toBe("0.0000");

    // On the withdrawal's own date it is allowed, and the ageing ties before, on and after it.
    await reverse(invoiceId, "2026-04-01");
    for (const asOf of ["2026-03-28", "2026-04-01", "2026-04-30"]) {
      expect(await tie(asOf), asOf).toBe("0.0000");
    }
  });
});
