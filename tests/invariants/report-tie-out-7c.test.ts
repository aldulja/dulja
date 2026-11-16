import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Sql } from "postgres";
import { currency, validateReportDefinition } from "@dulja/domain";
import { reportDefinitionSets, withTenant } from "@dulja/db";
import { grantCodes } from "@dulja/db/test";
import { startApi, type StartedApi } from "../../apps/api/test/support/app";
import { problemOf } from "../support/api";
import {
  assertFieldCoverage,
  assertTieOut,
  runDefinition,
  type TieOutOptions,
} from "./support/reports";
import {
  CATALOGUE_7C,
  CATALOGUE_DIR_7C,
  arApReportFixture,
  crossParams,
  paramsFor,
  posParams,
  posRange,
  posReportFixture,
  readDefinition7C,
  readEnvelope7C,
  type ArApReportFixture,
  type PosRange,
  type PosReportFixture,
} from "./support/reports-7c";

/**
 * 7C Task 14 — the Phase 7 definition of done for this slice's catalogue: "every report's numbers tie to the
 * ledger" (spec:2293, ADR 0068). Every SHIPPED 7C definition's declared `tieOut` is executed here against the
 * two 7C fixtures, and a shipped definition with no case fails by name. The parameters are the group tests'
 * own (`paramsFor`, `posParams`, `crossParams` in `support/reports-7c.ts`), so a case here and its group test
 * cannot drift apart; the windows and the one witness are the group tests' too.
 *
 * Nine and one (round 15, A16 item 1): five `ledger_sum`, four `projection` and `pos.needs_attention`'s `none`
 * with its row witness. ⚠️ OD-09's `accounting.pdc_register` is not built (`docs/decisions/od-09-7c-pdc-register.md`)
 * and is skipped by name only when its file is absent.
 *
 * One container: `startApi()` owns the database, `posReportFixture` needs the `StartedApi` (6C's `staffFixture`
 * does), and the AR/AP corpus lives in a second tenant of the same database.
 */
const MYR = currency("MYR");

interface Case {
  on: "pos" | "accounting";
  opts: TieOutOptions;
}

/** Every code's parameters, window and witness, in ONE place. A code with no entry throws by name. */
function caseFor(code: string, p: PosReportFixture, a: ArApReportFixture, range: PosRange): Case {
  const posSales = {
    fromDate: range.fromDate,
    toDate: range.toDate,
    accountTypes: ["income"],
    documentTypeCodes: ["POS_TICKET"],
  } as const;
  switch (code) {
    case "accounting.ageing":
      return {
        on: "accounting",
        opts: { params: paramsFor(code, a), baseCurrency: MYR, asOf: a.ageingAsOf },
      };
    case "accounting.party_statement":
      return {
        on: "accounting",
        opts: {
          params: paramsFor(code, a),
          baseCurrency: MYR,
          window: { partyId: a.customerId, fromDate: "2026-01-01", toDate: "2026-01-31" },
        },
      };
    case "accounting.allocation_register":
    case "accounting.unreconciled_items":
      return { on: "accounting", opts: { params: paramsFor(code, a), baseCurrency: MYR } };
    case "pos.z_report":
      return { on: "pos", opts: { params: posParams(code, p, range), baseCurrency: MYR } };
    case "pos.sales_by_cashier":
    case "pos.sales_by_branch":
      return {
        on: "pos",
        opts: { params: posParams(code, p, range), baseCurrency: MYR, window: posSales },
      };
    // `tieOut.kind` is `none`: a witness is MANDATORY (7B A5) — the open needs-attention rows themselves.
    case "pos.needs_attention":
      return {
        on: "pos",
        opts: {
          params: posParams(code, p, range),
          baseCurrency: MYR,
          witness: {
            key: ["client_ref"],
            rows: (tx: Sql) => tx<{ client_ref: string }[]>`
              select na.client_ref::text as client_ref from app.needs_attention na
               where na.company_id = ${p.s.company} and na.resolved_at is null order by na.client_ref`,
          },
        },
      };
    // `branchId` on BOTH sides (A5): the report side takes `statementRows`' ledger_entry branch, and A3's
    // `LedgerWindow.branchId` narrows the ledger side by `document.branch_id`.
    case "accounting.branch_profit_and_loss":
      return {
        on: "accounting",
        opts: {
          params: crossParams(code, a),
          baseCurrency: MYR,
          window: {
            fiscalPeriodId: a.fiscalPeriodId,
            branchId: a.s.hq,
            accountTypes: ["income", "expense"],
          },
        },
      };
    case "accounting.tax_return_view":
      return {
        on: "accounting",
        opts: {
          params: crossParams(code, a),
          baseCurrency: MYR,
          window: { fiscalPeriodId: a.fiscalPeriodId, accountCode: "2300" },
        },
      };
    default:
      throw new Error(
        `report-tie-out-7c: ${code} has no tie-out case — ADR 0068 requires one before the definition ships`,
      );
  }
}

/** Which codes actually shipped — `accounting.pdc_register` would be the one absent (⚠️ OD-09). */
const shipped = CATALOGUE_7C.filter((code) => existsSync(join(CATALOGUE_DIR_7C, `${code}.json`)));
const REEXPRESSED = new Set(["accounting.ageing", "pos.z_report", "pos.sales_by_cashier"]);

describe("Phase 7 DoD — every report's numbers tie (7C's catalogue, spec:2293, ADR 0068)", () => {
  let api: StartedApi;
  let p: PosReportFixture;
  let a: ArApReportFixture;
  let range: PosRange;

  beforeAll(async () => {
    api = await startApi();
    p = await posReportFixture(api, "tie-7c-pos");
    a = await arApReportFixture(api.db, "tie-7c-acc");
    range = posRange();
  }, 600_000);
  afterAll(async () => {
    await api?.stop();
  });

  const runAs = <T>(on: Case["on"], fn: (tx: Sql) => Promise<T>): Promise<T> => {
    const s = on === "pos" ? p.s : a.s;
    const actorId = on === "pos" ? p.reader : a.reader;
    return withTenant(
      api.db.rw,
      { tenantId: s.tenant, actorId, requestId: crypto.randomUUID() },
      fn,
    );
  };

  it("every §4.16.1 7C code ships a definition — ten, the OD-09 one is the only one that may be absent", () => {
    expect(CATALOGUE_7C.filter((c) => !shipped.includes(c))).toEqual([]);
    expect(shipped.length).toBe(10);
    // The OD-09 code is not in the catalogue at all while post-dated cheques are not built.
    expect(CATALOGUE_7C as readonly string[]).not.toContain("accounting.pdc_register");
    expect(existsSync(join(CATALOGUE_DIR_7C, "accounting.pdc_register.json"))).toBe(false);
  });

  it("every shipped definition has a tie-out case — a new code cannot be silently untested", () => {
    for (const code of shipped) expect(() => caseFor(code, p, a, range), code).not.toThrow();
    expect(() => caseFor("accounting.not_in_the_catalogue", p, a, range)).toThrow(
      /has no tie-out case/,
    );
  });

  it("the roll-up is nine and one: five ledger_sum, four projection, one none (A16 item 1)", () => {
    const kinds = shipped.map((c) => readDefinition7C(c).tieOut.kind);
    expect(kinds.filter((k) => k === "ledger_sum").length).toBe(5);
    expect(kinds.filter((k) => k === "projection").length).toBe(4);
    expect(kinds.filter((k) => k === "none").length).toBe(1);
    const projections = shipped
      .map((c) => readDefinition7C(c).tieOut)
      .flatMap((t) => (t.kind === "projection" && t.projection !== undefined ? [t.projection] : []))
      .toSorted();
    expect(projections).toEqual(["allocation", "bank_statement_line", "party_ageing", "shift"]);
  });

  it("a definition whose kind is `none` supplies a witness — `none` never means no test (7B A5)", () => {
    for (const code of shipped) {
      if (readDefinition7C(code).tieOut.kind !== "none") continue;
      expect(caseFor(code, p, a, range).opts.witness, code).toBeDefined();
    }
  });

  it.each([...shipped])(
    "%s validates, covers its fields and its declared tie-out passes",
    async (code) => {
      const definition = readDefinition7C(code);
      const c = caseFor(code, p, a, range);
      const sets = await runAs(c.on, (tx) => reportDefinitionSets(tx));
      expect(validateReportDefinition(definition, sets).errors, code).toEqual([]);
      const rows = await runAs(c.on, (tx) => runDefinition(tx, definition, c.opts.params));
      expect(rows.length, `${code} returned no rows against its fixture`).toBeGreaterThan(0);
      assertFieldCoverage(definition, rows);
      await runAs(c.on, (tx) => assertTieOut(tx, definition, c.opts));
    },
    120_000,
  );

  it("the three re-expressed codes carry definitionVersion 2, the seven new ones 1", () => {
    for (const code of shipped) {
      expect(readEnvelope7C(code).definitionVersion, code).toBe(REEXPRESSED.has(code) ? 2 : 1);
    }
    expect(shipped.filter((c) => !REEXPRESSED.has(c)).length).toBe(7);
  });

  it("7A's runs route takes all seven new codes past its grammar and the export gate", async () => {
    // 7A's gate order is requireReportExport → resolveDefinitionForRun → requireReportRead, so an UNGRANTED
    // caller gets 403 for every code and proves nothing (7B's roll-up grants the same way).
    await grantCodes(api.db, a.s, {
      codes: ["accounting.report.export"],
      principalId: a.reader,
      roleCode: "phase7c_exporter",
    });
    for (const code of shipped.filter((c) => !REEXPRESSED.has(c))) {
      // 404 is the PASSING result: this tenant's pack was never applied (Task 4's loader case owns that), so
      // no definition resolves. A code outside the grammar would answer 400 instead.
      const res = await api.request({
        method: "POST",
        path: `/v1/companies/${a.s.company}/reports/${code}/runs`,
        as: a.reader,
        body: { parameters: {}, format: "csv", lang: "en" },
      });
      expect(res.status, `${code} answered ${res.status}`).toBe(404);
      expect((await problemOf(res)).code, code).toBe("ERR_NOT_FOUND");
    }
  });
});
