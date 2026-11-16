import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parsePolicy, validateDocumentTypeSeed, validatePolicy } from "@dulja/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// Relative imports, never `@dulja/db*`: 0B's `dependency-rule` keys the owner on the path prefix
// `packages/db/`, so `test/**` is in its scope too and `@dulja/domain` is the only package specifier
// any file under this package may name (0b:5052, 0b:5091).
import {
  ADJUSTMENT_ACCOUNT_CODES,
  COST_ADJUSTMENT_CODE,
  resolveAdjustmentAccounts,
} from "../../src/costing/cost-adjustment";
import { loadDocumentTypes } from "../../src/seed/document-types";
import { readPackFile } from "../../src/seed/packs";
import { seedItem, seedTenantV2, type Seed } from "../fixtures";
import { startDb, uuidv7, withTenant, type Db } from "../harness";

/**
 * Resolved from THIS file, never from the cwd: Vitest runs this package from `packages/db`, so the bare
 * string `"packages/db/seed/my"` would resolve to `packages/db/packages/db/seed/my` and the loader would
 * raise ENOENT. 1A's document-types suite resolves the same pack the same way (1a:5114).
 */
const PACK = fileURLToPath(new URL("../../seed/my", import.meta.url));
const TYPES = join(PACK, "document-types");

describe("COST_ADJUSTMENT (contracts §4.14, §4.7.3; amendment A12)", () => {
  let db: Db;
  let s: Seed;
  let catalogue: string[];

  beforeAll(async () => {
    db = await startDb();
    s = await seedTenantV2(db, "CostAdj");
    // The permission catalogue as DATA, read from the table: `packages/db` may not import
    // `@dulja/contracts` (0B's `dependency-rule`; 1a:5105 spells out this exact substitution). `app.permission`
    // is global, carries no `tenant_id` and no RLS (plan0A:1313), migration 0014 is its only writer, and
    // `permission-catalogue.test.ts` pins it equal to `PERMISSIONS` in both directions — so the two sources
    // cannot disagree. 1A's loader suite reads it the same way (1a:5131-5132), and `no-bare-db` allows
    // `db.admin` under `packages/db/test/` (0b:4969).
    catalogue = (await db.admin<{ code: string }[]>`select code from app.permission`).map(
      (row) => row.code,
    );
    // `seedTenantV2` seeds only 1000 and 4000 (plan0A:1592-1594). 3A's `seedItem` idempotently seeds
    // `ITEM_DEFAULT_ACCOUNTS` = 1300, 5000, 5900 — the three codes this slice resolves — so one call is
    // how a Testcontainers company gets a chart without applying 0C's pack.
    await seedItem(db, s, { code: "CA-CHART" });
  }, 180_000);
  afterAll(async () => {
    await db.stop();
  });

  it("the seed file is a valid envelope whose policy validates against the catalogue", () => {
    const envelope = readPackFile<Record<string, unknown>>(
      PACK,
      "document-types",
      "COST_ADJUSTMENT.json",
    );
    expect(envelope.code).toBe(COST_ADJUSTMENT_CODE);
    expect(envelope.module).toBe("accounting");
    expect(validateDocumentTypeSeed(envelope)).toEqual({ ok: true, errors: [] });
    expect(validatePolicy(envelope.policy, catalogue)).toEqual({ ok: true, errors: [] });
    const policy = parsePolicy(envelope.policy);
    expect(policy.direction).toBe("internal");
    expect(policy.inventory.effect).toBe("none"); // a recost moves VALUE, never quantity (spec:1224)
    expect(policy.numbering.series).toBe("CA");
    expect(policy.approval).toEqual({
      required: false,
      approve: null,
      post: "accounting.journal.post",
    });
    // Amendment A12: line.account, not account.code — the job supplies the account and the direction.
    // `AccountRef` is the generated union `{ from } | { code }`, so the `from` half is narrowed rather
    // than read blind; a rule that regressed to `{ code: "1300" }` reads `null` here and fails.
    expect(
      policy.lines.map((rule) => [
        rule.side,
        "from" in rule.account ? rule.account.from : null,
        rule.amount,
      ]),
    ).toEqual([
      ["debit", "line.account", "line.debit"],
      ["credit", "line.account", "line.credit"],
    ]);
  });

  it("both account codes this slice consumes resolve in a freshly seeded company (hazard 33)", async () => {
    // `loadDocumentTypes` takes a POOL and opens its own `withTenant` (src/seed/document-types.ts:45), so it
    // is called directly: handing it a transaction makes the production `withTenant` raise
    // ERR_TENANT_CONTEXT_NESTED, which is why `replay.test.ts` calls it the same way.
    const ctx = { tenantId: s.tenant, actorId: s.system, requestId: await uuidv7(db.admin) };
    await loadDocumentTypes(db.migrator, ctx, TYPES, catalogue);
    const resolved = await withTenant(db.rw, s.tenant, s.system, (tx) =>
      resolveAdjustmentAccounts(tx, s.company),
    );
    expect(resolved.inventoryAccountId).toMatch(/^[0-9a-f-]{36}$/);
    expect(resolved.cogsAccountId).toMatch(/^[0-9a-f-]{36}$/);
    expect(resolved.documentTypeId).toMatch(/^[0-9a-f-]{36}$/);
    expect(ADJUSTMENT_ACCOUNT_CODES).toEqual({ inventory: "1300", cogs: "5000" });
  });

  it("a company missing the chart fails loudly, naming the FIRST missing code and what it is for", async () => {
    const bare = await seedTenantV2(db, "NoChart"); // seedTenantV2 seeds 1000/4000 only (plan0A:1592-1594)
    await loadDocumentTypes(
      db.migrator,
      { tenantId: bare.tenant, actorId: bare.system, requestId: await uuidv7(db.admin) },
      TYPES,
      catalogue,
    );
    // `resolveAdjustmentAccounts` checks 1300 before 5000 and raises on the first one missing, so THAT is
    // the code the message names. Both are absent on a bare tenant; asserting on 5000 would fail.
    await expect(
      withTenant(db.rw, bare.tenant, bare.system, (tx) =>
        resolveAdjustmentAccounts(tx, bare.company),
      ),
    ).rejects.toThrow(/ERR_NOT_FOUND.*account code 1300 \(inventory control\)/s);
  });

  it("5900 — the contra account the receipt fixture posts to — also resolves once seedItem has run", async () => {
    // §4.15 seeds it in 0C's `0c-base.json` and 3A's `seedItem` re-asserts it; this slice only consumes it
    // (hazard 33), and STOCK_RECEIPT_COST_POLICY addresses it by code because a `product` leaves
    // `item.expense_account_id` null (§4.6.1).
    const [row] = await withTenant(
      db.rw,
      s.tenant,
      s.system,
      (tx) => tx<{ id: string | null }[]>`
      select (select id::text from app.account where company_id = ${s.company} and code = '5900') as id`,
    );
    expect(row!.id).not.toBeNull();
  });

  it("the tenant's system principal passes accounting.journal.post with no role grant (plan0A:1363)", async () => {
    const [ok] = await withTenant(
      db.rw,
      s.tenant,
      s.system,
      (tx) => tx<{ ok: boolean }[]>`
      select app.actor_has('accounting.journal.post', ${s.company}, ${s.hq}) as ok`,
    );
    expect(ok!.ok).toBe(true);
    // …and a human with no grant does not, so the case above is not vacuous.
    const [no] = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ ok: boolean }[]>`
      select app.actor_has('accounting.journal.post', ${s.company}, ${s.hq}) as ok`,
    );
    expect(no!.ok).toBe(false);
  });
});
