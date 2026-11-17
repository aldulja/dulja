import { describe, expect, it } from "vitest";
import { ItemAccountUnresolvedError, resolveItemAccounts, withTenant } from "@dulja/db";
import { seedAccount, seedUnit } from "@dulja/db/test";
import { sharedDb } from "../support/regression";

describe("LEGACY-064 Copy-paste dead NULL guard; BuyCur never defaulted — 3A", () => {
  it("an unresolvable account default raises and names the code; it is never written back as NULL", async () => {
    const { rw, b } = await sharedDb();
    // Tenant B's chart has 1000 and 4000 only, exactly as seedTenant leaves it (contracts §4.1).
    // The old system's third test re-checked a value line 63 had just forced non-null, so it never
    // fired, and a NULL CstBuyCur was written back anyway. Here the failure is loud and named.
    await expect(
      withTenant(rw, { tenantId: b.tenant, actorId: b.human, requestId: "legacy-064" }, (tx) =>
        resolveItemAccounts(tx, { companyId: b.company, kind: "product" }),
      ),
    ).rejects.toThrow(ItemAccountUnresolvedError);
    const [n] = await withTenant(
      rw,
      { tenantId: b.tenant, actorId: b.human, requestId: "legacy-064" },
      (tx) =>
        tx<
          { n: number }[]
        >`select count(*)::int as n from app.item where inventory_account_id is null`,
    );
    expect(n!.n).toBe(0);
  });

  it("an explicit null override is honoured, so 'no account' and 'unresolved' are different answers", async () => {
    const { db, rw, a } = await sharedDb();
    // The product defaults this case resolves, seeded here rather than inherited: `seedTenant` gives tenant A
    // 1000 and 4000 only, and 5000/5900 existed only if another file's `seedItem` had run in A first — which
    // held in one file order and not in another (the `tests` run shares one `sharedDb()` per worker).
    // `seedAccount` is idempotent on (company_id, code), so a file that did seed them is unaffected.
    await seedAccount(db, a, { code: "5000", nameEn: "Cost of goods sold", type: "expense" });
    await seedAccount(db, a, { code: "5900", nameEn: "Other operating expense", type: "expense" });
    const unitId = await seedUnit(db, a, { code: "LEGACY064-U" });
    const accounts = await withTenant(
      rw,
      { tenantId: a.tenant, actorId: a.human, requestId: "legacy-064" },
      (tx) =>
        resolveItemAccounts(tx, {
          companyId: a.company,
          kind: "product",
          overrides: { inventoryAccountId: null },
        }),
    );
    expect(accounts.inventoryAccountId).toBeNull();
    expect(accounts.cogsAccountId).not.toBeNull();
    void unitId;
  });
});
