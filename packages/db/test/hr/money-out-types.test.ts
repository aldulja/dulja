import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { validateDocumentTypeSeed, validatePolicy } from "@dulja/domain";
import { loadDocumentTypes } from "../../src/seed/document-types";
import { startDb, withTenant, type Db } from "../harness";
import { seedAccount, seedTenantV2, type Seed } from "../fixtures";
import { payrollFixture, PAYROLL_PACK_ROOT } from "../../../../tests/invariants/support/payroll";

// 8C T5 — the PAYROLL_PAYMENT and EMPLOYEE_ADVANCE envelopes (§4.3.7, §4.14, round 18 B8/B9).

let db: Db;
let s: Seed;
/** The permission catalogue, read from `app.permission` — a `packages/db` test other than
 *  `permission-catalogue.test.ts` may not import `@dulja/contracts` (round 18 B16 item 3). That table is global and
 *  `permission-catalogue.test.ts` pins it equal to `PERMISSIONS` in both directions. */
let catalogue: string[];

beforeAll(async () => {
  db = await startDb();
  s = await seedTenantV2(db, "Money-out types");
  await payrollFixture(db, s); // applies 8B's chart file, so 1400/2400/241n exist
  // `seedTenantV2` builds a synthetic chart (1000, 4000) rather than applying 0C's file, so 0C's `1100` row is applied
  // here from the SHIPPED file — the same way `payrollFixture` applies 8B's — never restated by hand.
  const bank = chartRow("0c-base.json", "1100");
  await seedAccount(db, s, { code: bank.code, nameEn: bank.nameEn, type: bank.type });
  catalogue = (
    await db.admin<{ code: string }[]>`select code from app.permission order by code`
  ).map((r) => r.code);
}, 180_000);
afterAll(async () => {
  await db.stop();
});

const DOCUMENT_TYPES = join(PAYROLL_PACK_ROOT, "document-types");
type ChartRow = {
  code: string;
  nameEn: string;
  type: "asset" | "liability" | "equity" | "income" | "expense";
  isGroup?: boolean;
};
const chartRows = (file: string): ChartRow[] =>
  JSON.parse(
    readFileSync(join(PAYROLL_PACK_ROOT, "chart-of-accounts", file), "utf8"),
  ) as ChartRow[];
const chartRow = (file: string, code: string): ChartRow => {
  const row = chartRows(file).find((r) => r.code === code);
  if (row === undefined) throw new Error(`${file} has no row ${code}`);
  return row;
};
const envelopeOf = (code: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(DOCUMENT_TYPES, `${code}.json`), "utf8")) as Record<string, unknown>;

/**
 * HAZARD 33, discharged. This slice's two policies name `2400`, `1400` and `1100` by code and seed none of them —
 * `2400` and `1400` are 8B's, `1100` is 0C's. A consuming slice's first task in that area asserts the account
 * resolves, before any policy naming it is loaded.
 */
describe("the three account codes these policies name (hazard 33, §4.15)", () => {
  it.each([
    ["2400", "8b-payroll.json"],
    ["1400", "8b-payroll.json"],
    ["1100", "0c-base.json"],
  ])(
    "%s is a leaf of the shipped chart file %s — seeded by its owning slice, never by 8C",
    (code, file) => {
      const row = chartRow(file, code);
      expect(row.isGroup ?? false).toBe(false);
    },
  );

  it.each(["2400", "1400", "1100"])(
    "%s resolves to one leaf in the company and was seeded elsewhere",
    async (code) => {
      const rows = await withTenant(
        db.rw,
        s.tenant,
        s.human,
        (tx) => tx<{ id: string; type: string; is_group: boolean }[]>`
        select id, type::text as type, is_group from app.account
         where company_id = ${s.company} and code = ${code} and archived_at is null`,
      );
      expect(
        rows,
        `account ${code} does not resolve — 8B's chart file or 0C's base chart has not been applied`,
      ).toHaveLength(1);
      expect(rows[0]!.is_group).toBe(false);
    },
  );
});

describe("PAYROLL_PAYMENT.json and EMPLOYEE_ADVANCE.json (§4.3.7, §4.14, amendment B8)", () => {
  it.each([
    ["PAYROLL_PAYMENT", "PAYB", "hr.payroll.pay", "2400"],
    ["EMPLOYEE_ADVANCE", "ADV", "hr.advance.create", "1400"],
  ])("%s is a valid envelope in module hr with series %s", (code, series, create, accountCode) => {
    const envelope = envelopeOf(code) as {
      code: string;
      module: string;
      policy: Record<string, unknown>;
    };
    expect(validateDocumentTypeSeed(envelope)).toEqual({ ok: true, errors: [] });
    expect(envelope.code).toBe(code);
    expect(envelope.module).toBe("hr"); // hazard 34: NOT the module of approval.post

    const policy = envelope.policy as {
      direction: string;
      numbering: { series: string };
      approval: { required: boolean; create: string; approve: string; post: string };
      reversal: { allowed: boolean; producesType: string | null };
      dimensions: { required: string[] };
      lines: {
        for: string;
        side: string;
        account: Record<string, string>;
        amount: string;
        when?: Record<string, string>;
        dimensions?: { from: string[] };
      }[];
      tax: { applies: boolean };
      inventory: { effect: string };
    };
    expect(validatePolicy(policy, catalogue)).toEqual({ ok: true, errors: [] });
    expect(policy.direction).toBe("outbound");
    expect(policy.inventory.effect).toBe("none");
    expect(policy.tax.applies).toBe(false);
    expect(policy.numbering.series).toBe(series);
    expect(policy.approval).toEqual({
      required: true,
      create,
      approve: "accounting.payment.approve",
      post: "accounting.payment.post",
    });
    expect(policy.reversal).toEqual({ allowed: true, producesType: code });
    expect(policy.dimensions.required).toEqual(["BRANCH"]); // amendment B8 — NOT ["BRANCH","EMPLOYEE"]
    expect(policy.lines).toHaveLength(2);

    const perLine = policy.lines.find((l) => l.for === "each_line")!;
    expect(perLine.side).toBe("debit");
    expect(perLine.account).toEqual({ code: accountCode });
    expect(perLine.amount).toBe("line.amount");
    expect(perLine.when).toEqual({ "line.kind": "payroll" });
    expect(perLine.dimensions).toEqual({ from: ["line.dimensions"] }); // amendment B8/B9

    const bank = policy.lines.find((l) => l.for === "document")!;
    expect(bank.side).toBe("credit");
    expect(bank.account).toEqual({ code: "1100" });
    expect(bank.amount).toBe("document.total_excl_tax");
    expect(bank.dimensions).toBeUndefined(); // the schema default: line bag + document.branch
  });

  it("loads into the tenant as a document_type with module hr and one posting_policy version", async () => {
    const ctx = {
      tenantId: s.tenant,
      actorId: s.system,
      requestId: "00000000-0000-0000-0000-000000000000",
    };
    const results = await loadDocumentTypes(db.rw, ctx, DOCUMENT_TYPES, catalogue);
    for (const code of ["PAYROLL_PAYMENT", "EMPLOYEE_ADVANCE"]) {
      const r = results.find((x) => x.code === code);
      expect(r, `${code} was not loaded`).toBeDefined();
      expect(r!.created).toBe(true);
      const [row] = await db.admin<{ module: string; versions: number }[]>`
        select t.module,
               (select count(*)::int from app.posting_policy p where p.document_type_id = t.id) as versions
          from app.document_type t where t.company_id = ${s.company} and t.code = ${code}`;
      expect(row!.module).toBe("hr");
      expect(row!.versions).toBe(1);
    }
  });
});
