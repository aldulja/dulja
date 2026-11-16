import { beforeAll, describe, expect, it } from "vitest";
import { listEmployeeYtdOpening, trialBalance, valuationAsOf, withTenant } from "@dulja/db";
import { currency, Money } from "@dulja/domain";
import { sourceFiles } from "../support/source";
import {
  assertExplained,
  cutOverFixture,
  loadFromCorpus,
  reconcileFor,
  type CutOverFixture,
} from "./support/cut-over";

// 9B T10 — Phase 9's definition of done (spec:2295): "Trial balance and stock valuation match the source on the
// cut-over date, and the difference on every recomputed figure is explained (§5.1); each employee's imported YTD
// reconciles to their last legacy payslip." Computed by `reconcileCutOver` (ADR 0086) and witnessed here through the
// tree's own reads — the trial-balance projection, `valuationAsOf` and `listEmployeeYtdOpening` — none of which the
// reconciliation itself uses for the trial balance (it reads the ledger), so the two halves cannot agree by sharing a bug.

let f: CutOverFixture;
const MYR = currency("MYR");

/** Every total is summed as `Money`, never with `Number(...)` (spec:2041): a tie-out in floating point is not a
 *  tie-out to the cent, which is the whole claim. */
const sum = (values: readonly string[]) =>
  values.reduce((m, v) => m.add(Money.of(v, MYR)), Money.zero(MYR));

// INTO `f`: the one-argument `loadFromCorpus("cut-over")` builds a tenant of its own, so every read below would see an
// empty one. No `afterAll` teardown: the api is `sharedApi()`'s (§4.17.1) and is never stopped by a consumer.
beforeAll(async () => {
  f = await cutOverFixture("dod");
  await loadFromCorpus(f, "cut-over");
}, 300_000);

describe("Phase 9 definition of done (spec:2295)", () => {
  it("the trial balance balances after the load, with every residue on 3900", async () => {
    const rows = await withTenant(f.api.db.rw, f.ctx, async (tx) => {
      // The tree's trial balance reads one fiscal period's projection; the cut-over date's is 0A's open 2026-01.
      const [period] = await tx<{ id: string }[]>`
        select id::text as id from app.fiscal_period
         where company_id = ${f.ctx.companyId} and ${f.ctx.cutOverDate}::date between starts_on and ends_on`;
      return trialBalance(tx, {
        companyId: f.ctx.companyId,
        fiscalPeriodId: period!.id,
        limit: 1000,
      });
    });
    expect(sum(rows.map((r) => r.baseDebit)).toString()).toBe(
      sum(rows.map((r) => r.baseCredit)).toString(),
    );
    const suspense = rows.find((r) => r.accountCode === "3900");
    expect(
      suspense &&
        Money.of(suspense.baseCredit, MYR).subtract(Money.of(suspense.baseDebit, MYR)).toString(),
    ).toBe("6080.0000");
  });

  it("the stock valuation equals the recomputed opening to the cent", async () => {
    const rows = await withTenant(f.api.db.rw, f.ctx, (tx) =>
      valuationAsOf(tx, { companyId: f.ctx.companyId, asOf: f.ctx.cutOverDate, limit: 1000 }),
    );
    expect(sum(rows.map((r) => r.value)).toString()).toBe("180.0000");
  });

  it("every employee's imported YTD reconciles to their last legacy payslip", async () => {
    const openings = await withTenant(f.api.db.rw, f.ctx, (tx) =>
      listEmployeeYtdOpening(tx, { companyId: f.ctx.companyId, year: 2026 }),
    );
    // Two rows, because both corpus employees reconcile. An employee whose YTD drifted would be ABSENT here and named
    // in the skip register (T8) — a missing row, never a zero.
    expect(openings).toHaveLength(2);
    expect(
      openings.every(
        (o) => Money.of(o.gross, MYR).isPositive() && Money.of(o.net, MYR).isPositive(),
      ),
    ).toBe(true);
  });

  it("leaves NOTHING unexplained — every difference is zero or traced to a named cause, and 3900 decomposes exactly", async () => {
    const rec = await withTenant(f.api.db.rw, f.ctx, (tx) => reconcileFor(tx, f));
    expect(rec.unexplained).toEqual([]);
    expect(rec.ok).toBe(true);
    expect(rec.suspenseBalance).toBe("-6080.0000");
    expect(rec.suspense.map((r) => [r.key, r.difference, r.explanation !== null])).toEqual([
      ["legacy imbalance", "8300.0000", true],
      ["3900", "0.0000", true],
    ]);
    // …and the ledger itself nets to zero, with every 3900 row a cut-over line that says why it is there (amendment
    // C6's helper; it throws naming every non-zero balance, so a failure reads as a trial balance).
    await assertExplained(f);
  });

  it("leaves no live legacy credential behind (acceptance test 34's clause, spec:2090)", () => {
    const offenders = sourceFiles(["packages/importer/src", "apps/worker/src", "apps/api/src"])
      .filter((file) => /DSN=|PWD=|masterkey/i.test(file.text))
      .map((file) => file.path);
    expect(offenders).toEqual([]);
  });
});
