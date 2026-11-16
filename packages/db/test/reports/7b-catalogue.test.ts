import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { validateReportDefinition } from "@dulja/domain";
import { DATASET_IDS } from "../../src/reports/datasets";
import { reportDefinitionSets } from "../../src/reports/definition-store";
import { reportsLoader } from "../../src/seed/reports";
import { startDb, withTenant, type Db } from "../harness";
// §4.17.1's 7B harness, reachable from packages/db/test/** through 3B's amendment A21(c).
import {
  CATALOGUE_7B,
  CATALOGUE_DIR,
  readEnvelope,
  reportFixture,
  type ReportFixture,
} from "../../../../tests/invariants/support/reports";

/**
 * 7B Task 9 — the catalogue completeness gate and the reports seed pack (§4.16.1, §3.4.8).
 *
 * §4.16.1's assignment, as a literal. A disagreement between this table and a definition is a register
 * violation (hazard 32), not a preference — which is why the table is written out rather than derived.
 */
const REGISTER: Readonly<Record<string, { permission: string; version: number }>> = {
  "accounting.general_ledger": { permission: "accounting.report.read", version: 1 },
  "accounting.journal_register": { permission: "accounting.report.read", version: 1 },
  "accounting.account_statement": { permission: "accounting.report.read", version: 1 },
  "accounting.period_comparison": { permission: "accounting.report.read", version: 1 },
  "accounting.profit_and_loss": { permission: "accounting.report.read", version: 1 },
  "accounting.balance_sheet": { permission: "accounting.report.read", version: 1 },
  "accounting.document_register": { permission: "accounting.report.read", version: 1 },
  "accounting.audit_log": { permission: "admin.audit_log.read", version: 1 },
  "accounting.document_event_log": { permission: "admin.audit_log.read", version: 1 },
  "accounting.trial_balance": { permission: "accounting.report.read", version: 2 },
  "accounting.ledger": { permission: "accounting.report.read", version: 2 },
  "inventory.stock_ageing": { permission: "inventory.cost.read", version: 1 },
  "inventory.movement_register": { permission: "inventory.stock.read", version: 1 },
  "inventory.expiry_list": { permission: "inventory.stock.read", version: 1 },
  "inventory.price_list": { permission: "inventory.item.read", version: 1 },
  "inventory.promotion_register": { permission: "inventory.item.read", version: 1 },
  "inventory.transfer_register": { permission: "inventory.stock.read", version: 1 },
  "inventory.count_register": { permission: "inventory.stock.read", version: 1 },
  "inventory.profit_by_item": { permission: "inventory.cost.read", version: 1 },
  "inventory.stock_on_hand": { permission: "inventory.stock.read", version: 2 },
  "inventory.valuation": { permission: "inventory.cost.read", version: 2 },
  "inventory.sales_by_item": { permission: "inventory.stock.read", version: 2 },
};

/** The thirteen `DatasetId` members this catalogue reads. 7A's registry holds twenty-five (no `pdc`: OD-09);
 *  this slice adds none, and a definition naming a fourteenth here would be a §4.16.2 amendment. */
const SOURCES = [
  "ledger_entry",
  "account_balance",
  "document",
  "document_event",
  "audit_log",
  "inventory_movement",
  "cost_layer",
  "stock_on_hand",
  "stock_valuation",
  "item_profitability",
  "lot",
  "price_list_line",
  "promotion",
] as const;

/** §4.11.1's parameter kinds — the `Parameter.kind` union of 7A's generated `ReportDefinition`. */
/** The shipped pack, as `parseSeedConfig` resolves it when `--pack` is not given. */
const PACK_ROOT = fileURLToPath(new URL("../../seed/my", import.meta.url));

const KINDS = [
  "date",
  "date_range",
  "period",
  "account",
  "party",
  "item",
  "warehouse",
  "branch",
  "dimension_value",
  "enum",
  "text",
];

describe("7B catalogue completeness and the reports seed pack (§4.16.1, §3.4.8)", () => {
  let db: Db;
  let f: ReportFixture;

  beforeAll(async () => {
    db = await startDb();
    f = await reportFixture(db, "Alpha");
  }, 180_000);
  afterAll(async () => {
    await db?.stop();
  });

  it("the directory holds exactly the twenty-two codes, seventeen new and five re-expressed", () => {
    const onDisk = readdirSync(CATALOGUE_DIR)
      .filter((n) => n.endsWith(".json"))
      .map((n) => n.replace(/\.json$/, ""))
      .toSorted();
    expect(onDisk).toEqual([...CATALOGUE_7B].toSorted());
    expect(onDisk.length).toBe(22);
    const versions = onDisk.map((code) => readEnvelope(code).definitionVersion);
    expect(versions.filter((v) => v === 1).length).toBe(17);
    expect(versions.filter((v) => v === 2).length).toBe(5);
  });

  it("every definition matches §4.16.1's register: code, module, permission and row version", () => {
    for (const code of CATALOGUE_7B) {
      const envelope = readEnvelope(code);
      const row = REGISTER[code]!;
      expect(envelope.definition.code, code).toBe(code);
      expect(envelope.definition.module, code).toBe(code.split(".")[0]);
      expect(envelope.definition.permission, code).toBe(row.permission);
      expect(envelope.definitionVersion, code).toBe(row.version);
      expect(envelope.definition.version, code).toBe(1); // the FORMAT version (amendment A1)
    }
  });

  // `app.permission` is the catalogue at run time, and `permission-catalogue.test.ts` asserts it equals
  // `PERMISSIONS` in both directions — so it is read here rather than imported: `packages/db` may not import
  // `@dulja/contracts` (§3.1's dependency-rule; that one test is its only allowance).
  it("every permission a definition names is in the catalogue and is non-mutating", async () => {
    const rows = await db.admin<{ code: string; mutating: boolean }[]>`
      select code, mutating from app.permission`;
    const mutating = new Map(rows.map((r) => [r.code, r.mutating]));
    for (const code of CATALOGUE_7B) {
      const permission = readEnvelope(code).definition.permission;
      expect(mutating.has(permission), `${code} names ${permission}`).toBe(true);
      expect(mutating.get(permission), `${code}'s gate must be a read code`).toBe(false);
    }
  });

  it("every filter clause names a declared parameter, and every parameter kind is one §4.11.1 allows", () => {
    for (const code of CATALOGUE_7B) {
      const d = readEnvelope(code).definition;
      const declared = new Set(d.parameters.map((p) => p.name));
      for (const clause of d.dataset.filters) {
        expect(
          declared.has(clause.param),
          `${code}: filter on ${clause.field} names undeclared parameter ${clause.param}`,
        ).toBe(true);
      }
      for (const p of d.parameters) expect(KINDS, `${code}.${p.name}`).toContain(p.kind);
    }
  });

  it("this slice reads only datasets 7A already registered — no definition reaches for a new DatasetId", () => {
    for (const source of SOURCES) expect(DATASET_IDS).toContain(source);
    for (const code of CATALOGUE_7B) {
      const source = readEnvelope(code).definition.dataset.source;
      expect(SOURCES as readonly string[], `${code} reads ${source}`).toContain(source);
    }
  });

  // FIVE, not the plan's four: amendment A3 transcribed 7A's `lot` dataset, which carries no quantity, so
  // `inventory.expiry_list` is a lot list with a row witness (Task 5) — the plan's Self-Review table predates
  // that transcription. Each `none` still has an executed witness (A5).
  it("every tieOut is one the harness executes, and a `none` is one of exactly five codes", () => {
    const none: string[] = [];
    for (const code of CATALOGUE_7B) {
      const t = readEnvelope(code).definition.tieOut;
      if (t.kind === "none") {
        none.push(code);
        continue;
      }
      if (t.kind === "projection") {
        expect(
          ["account_balance", "stock_on_hand", "stock_valuation", "item_profitability"],
          code,
        ).toContain(t.projection);
      } else {
        expect(t.kind, code).toBe("ledger_sum");
      }
    }
    expect(none.toSorted()).toEqual([
      "accounting.audit_log",
      "accounting.document_event_log",
      "inventory.expiry_list",
      "inventory.price_list",
      "inventory.promotion_register",
    ]);
  });

  // `ReportCodeSchema` membership (amendment A4) is asserted in `tests/invariants/report-catalogue-pins.test.ts`
  // (Task 14): the enum is `@dulja/contracts`', which this workspace may not import.

  it("the reports loader seeds all twenty-two as core rows, and re-running it changes nothing", async () => {
    const ctx = {
      config: { tenantId: f.s.tenant, only: ["reports"], packRoot: PACK_ROOT } as never,
      tenantId: f.s.tenant,
      companyId: f.s.company,
      systemPrincipalId: f.s.system,
      packRoot: PACK_ROOT,
    };
    const first = await withTenant(db.rw, f.s.tenant, f.s.system, (tx) =>
      reportsLoader.load(tx, ctx),
    );
    const rows = await withTenant(
      db.rw,
      f.s.tenant,
      f.reader,
      (tx) => tx<{ code: string; version: number; is_core: boolean }[]>`
        select code, version, is_core from app.report_definition
         where company_id = ${f.s.company} order by code, version`,
    );
    // §4.2.13: a loader returns the rows it inserted. This company held no definition before, so that is every
    // row it now holds — 7B's twenty-two plus the later catalogue slices' own directories (7C's `7c/`), which
    // is why the total is read off the table rather than pinned here (§3.7.3).
    expect(first).toBe(rows.length);
    const mine = rows.filter((r) => (CATALOGUE_7B as readonly string[]).includes(r.code));
    expect(mine.length).toBe(22);
    expect(mine.every((r) => r.is_core)).toBe(true);
    for (const r of mine) expect(r.version, r.code).toBe(REGISTER[r.code]!.version);

    // Idempotent per §3.4.8: a second run inserts nothing and adds no row.
    const second = await withTenant(db.rw, f.s.tenant, f.s.system, (tx) =>
      reportsLoader.load(tx, ctx),
    );
    expect(second).toBe(0);
    const after = await withTenant(
      db.rw,
      f.s.tenant,
      f.reader,
      (tx) => tx<{ n: number }[]>`
        select count(*)::int as n from app.report_definition where company_id = ${f.s.company}`,
    );
    expect(after[0]!.n).toBe(rows.length);
  });

  it("a second tenant sees none of them (spec:106's Always clause, over a table this slice fills)", async () => {
    const other = await reportFixture(db, "Beta");
    const seen = await withTenant(
      db.rw,
      other.s.tenant,
      other.reader,
      (tx) => tx<{ n: number }[]>`select count(*)::int as n from app.report_definition`,
    );
    expect(seen[0]!.n).toBe(0);
  });

  it("every definition validates against 7A's validator with the real dataset and permission sets", async () => {
    // `reportDefinitionSets` reads both closed sets where they live at run time (DATASET_IDS and
    // app.permission) — the sets the seed loader itself validates against.
    const sets = await reportDefinitionSets(db.admin);
    for (const code of CATALOGUE_7B) {
      const result = validateReportDefinition(readEnvelope(code).definition, sets);
      expect(result.errors, `${code}: ${JSON.stringify(result.errors)}`).toEqual([]);
      expect(result.ok, code).toBe(true);
    }
  });
});
