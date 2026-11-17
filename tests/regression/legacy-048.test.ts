import { describe, expect, it } from "vitest";
import { repoFile, sharedDb } from "../support/regression";
import { sourceFiles } from "../support/source";

/**
 * LEGACY-048 — "Negative-stock and overcost controls are opt-in per user and have four bypasses."
 *
 * Cites: spec:1308, spec:2179, spec:2436, contracts §4.7.3, tests/invariants/stock-availability.test.ts.
 *
 * The invariant suite proves the BEHAVIOUR by every write path. This file asserts the SHAPE the behaviour
 * rests on, which is the half the legacy got wrong: the control is a trigger and not a setting.
 *
 * A bare `describe` rather than `thinRegression`/`sliceRegression`: both helpers wrap exactly ONE `it`
 * (`tests/support/regression.ts`), and these are four independent cases with four claims. Seventeen files in
 * `tests/regression/` already take this shape — `legacy-067.test.ts`, 3A's own, among them.
 */
describe("LEGACY-048 Negative-stock and overcost controls are opt-in per user and have four bypasses — 3A", () => {
  it("the control is a TRIGGER on the movement table, not a handler and not a user setting", async () => {
    const { db } = await sharedDb();
    const [trigger] = await db.admin<{ tgname: string; enabled: string; tgtype: number }[]>`
      select tgname, tgenabled::text as enabled, tgtype
        from pg_trigger
       where tgrelid = 'app.inventory_movement'::regclass and tgname = 'inventory_movement_stock_available'`;
    expect(trigger?.tgname).toBe("inventory_movement_stock_available");
    expect(trigger?.enabled).toBe("O"); // enabled, ORIGIN — never disabled "temporarily" (spec:97)
    expect(trigger!.tgtype & 4).toBe(4); // TRIGGER_TYPE_INSERT
    expect(trigger!.tgtype & 2).toBe(2); // TRIGGER_TYPE_BEFORE
  });

  it("there is no per-user stock setting anywhere: no column, no GUC, no catalogue code for one", async () => {
    const { db } = await sharedDb();
    const columns = await db.admin<{ table_name: string; column_name: string }[]>`
      select table_name, column_name from information_schema.columns
       where table_schema = 'app'
         and (column_name ilike '%allow_negative%' or column_name ilike '%skip_stock%'
           or column_name ilike '%negative_stock%')`;
    expect(columns).toEqual([]);
    // The one authority that exists is a PERMISSION exercised per document by a second principal, which is
    // an audited event and not a setting (spec:2179).
    const [code] = await db.admin<{ mutating: boolean }[]>`
      select mutating from app.permission where code = 'inventory.negative_stock.override'`;
    expect(code!.mutating).toBe(true);
  });

  it("the availability sum reads the movement ledger, never the projection", async () => {
    const { db } = await sharedDb();
    const [fn] = await db.admin<{ src: string }[]>`
      select prosrc as src from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'app' and p.proname = 'assert_stock_available'`;
    // Reading stock_on_hand would be wrong twice: it is MERGEd only at step 12, so an in-transaction
    // receipt would be invisible, and a drifted projection would become an authorisation decision.
    expect(fn!.src).toContain("app.inventory_movement");
    expect(fn!.src).not.toContain("stock_on_hand");
  });

  it("no source file reads a stock bypass flag of any kind", () => {
    const offenders = sourceFiles()
      .filter((f) =>
        /allow_negative_stock|skip_stock_check|ignore_stock|bypass_stock/i.test(f.text),
      )
      .map((f) => f.path);
    expect(offenders).toEqual([]);
  });
});

/**
 * 3A created this file; this slice appends the "on a real sale" block and edits none of 3A's four cases.
 * Both cases are pure reads of the catalogue and the function source, so the block needs no tenant of its
 * own. A plain `describe` for the reason the header above gives.
 */
describe("LEGACY-048 Negative stock rejected by the data layer on a real sale — 3D", () => {
  it("the DELIVERY_ORDER policy's allowNegative alone admits nothing without the event", async () => {
    // The legacy control was a per-user flag: setting it was enough. Here the flag is on the TYPE and it is
    // necessary but not sufficient — the second condition is a document_event by a second principal, and
    // amendment A8b makes `cost()` require BOTH.
    // Read from the SEED PACK and not from `app.posting_policy`, deliberately: `sharedDb()`'s two tenants
    // come from Plan 0A's `seedTenant`, which configures JOURNAL alone, so a query for DELIVERY_ORDER's
    // policy row would pass or fail on which OTHER regression file had run first in the shared container.
    // The pack file is what every tenant is configured from (§3.4.8), so it is the honest source.
    const pack = JSON.parse(repoFile("packages/db/seed/my/document-types/DELIVERY_ORDER.json")) as {
      policy: { inventory: { allowNegative?: boolean } };
    };
    expect(pack.policy.inventory.allowNegative).toBe(true);
    // …and the data layer's own gate never reads that flag: `assert_stock_available` looks for a
    // `document_event`, full stop. So setting `allowNegative` on a type admits nothing on its own — which
    // is the precise shape of the legacy defect, where setting the user flag WAS the admission. The
    // assertion is on the function source rather than on a row count, because a row count over the shared
    // regression container depends on which other files have run.
    const { db } = await sharedDb();
    const [gate] = await db.admin<{ src: string }[]>`
      select prosrc as src from pg_proc
       where proname = 'assert_stock_available' and pronamespace = 'app'::regnamespace`;
    expect(gate!.src).not.toMatch(/allowNegative|posting_policy/);
  });

  it("no session flag, GUC or user attribute can turn the check off", async () => {
    const { db } = await sharedDb();
    // The four legacy bypasses were: a user flag, a session variable, a direct table write and a second
    // write path. All four are closed: the check is a BEFORE INSERT trigger on the only table that holds a
    // movement, `app_rw` has no UPDATE or DELETE on it, and no GUC appears in the function body.
    const [fn] = await db.admin<{ src: string }[]>`
      select prosrc as src from pg_proc
       where proname = 'assert_stock_available' and pronamespace = 'app'::regnamespace`;
    expect(fn!.src).not.toMatch(/current_setting|set_config/i);
    expect(fn!.src).toMatch(/document_event/); // the ONE door, and it is an audited row
  });
});

import { fullRegression as posStockRegression } from "../support/api";
import { buildTicket, posFixture, syncRequest, uuidv7Sync } from "../invariants/support/pos";
posStockRegression("LEGACY-048", "POS overselling retains the stock invariant — 6A", {
  "a terminal flag or POS supervisor event cannot become an inventory override": async ({
    api,
  }) => {
    const f = await posFixture(api, "LEGACY048 POS");
    const ticket = buildTicket(f, {
      quantity: "999999.000000",
      events: [
        {
          kind: "override",
          code: "pos.ticket.override",
          subject: "price_override",
          supervisorPrincipalId: f.supervisorId,
          reason: "approved POS price",
        },
      ],
    });
    const batch = {
      terminalId: f.terminal.terminalId,
      batchId: uuidv7Sync(),
      tickets: [ticket],
      shifts: [],
      tillEvents: [],
    };
    expect(
      (
        await syncRequest(api, f.terminal, {
          method: "POST",
          path: "/v1/sync/tickets",
          body: { ...batch, skipChecks: true },
        })
      ).status,
    ).toBe(400);
    const res = await syncRequest(api, f.terminal, {
      method: "POST",
      path: "/v1/sync/tickets",
      body: batch,
    });
    expect(
      ((await res.json()) as { results: { error: { code: string } }[] }).results[0]!.error.code,
    ).toBe("ERR_STOCK_INSUFFICIENT");
    const [row] = await api.db.admin<
      { error_code: string }[]
    >`select error_code from app.needs_attention where client_ref=${ticket.clientRef}`;
    expect(row!.error_code).toBe("ERR_STOCK_INSUFFICIENT");
    const [guard] = await api.db.admin<
      { src: string }[]
    >`select prosrc as src from pg_proc where pronamespace='app'::regnamespace and proname='assert_stock_available'`;
    expect(guard!.src).toContain("inventory.negative_stock.override");
    expect(guard!.src).not.toMatch(/current_setting|set_config/);
    // The existing stock-availability and LEGACY-048 3D suites prove the distinct inventory override door.
  },
});
