import { startStubServer, type StubServer } from "@dulja/db/test/einvoice-stub";
import { uuidv7, type Seed } from "@dulja/db/test";
import {
  resetTransmitters,
  registerDefaultTransmitters,
  listTransmissions,
  registerTransmitter,
  createSyntheticTransmitter,
} from "@dulja/db";
import { einvoiceFixture } from "../invariants/support/einvoice";
// tests/regression/legacy-020.test.ts
// LEGACY-020 (H) — The GST return hardcodes a rate, uses an ambiguous date literal, and shares an enum with
// an incompatible meaning (spec:388). Created by slice 5A, the first slice in execution order to touch it.
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { withTenant } from "@dulja/db";
import { createTaxReturn, generateTaxReturn } from "@dulja/db";
import { startDb, type Db } from "@dulja/db/test";
import { sourceFiles } from "../support/source";
import { postTaxedDocument, taxFixture } from "../invariants/support/tax";
import { PayrollCalculationError, payrollCalculator } from "@dulja/domain/payroll";
import { repoFile } from "../support/regression";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../support/source";

describe("LEGACY-020 The GST return hardcodes a rate, uses an ambiguous date literal, and shares an enum — 5A", () => {
  let db: Db;
  beforeAll(async () => {
    db = await startDb();
  }, 180_000);
  afterAll(async () => {
    await db.stop();
  });

  it("the rate is a row, not a literal: changing the seeded rate changes the return with no code change", async () => {
    const f = await taxFixture(db, "legacy020-rate");
    const ctx = { tenantId: f.s.tenant, actorId: f.s.human, requestId: "legacy020" };
    await postTaxedDocument(db, f, {
      typeCode: "SALES_INVOICE",
      effectiveDate: "2026-01-10",
      taxInclusive: false,
      lines: [
        { lineNo: 1, accountId: f.accounts["4000"]!, amount: "1000.0000", taxCode: "SYN-OUT-STD" },
      ],
    });
    const before = await withTenant(db.rw, ctx, async (tx) => {
      const d = await createTaxReturn(tx, ctx, {
        companyId: f.s.company,
        regimeId: f.regimeId,
        periodStart: "2026-01-01",
        periodEnd: "2026-01-31",
      });
      return (await generateTaxReturn(tx, ctx, d.id)).boxes
        .find((b) => b.code === "S2")!
        .amount.toString();
    });
    expect(before).toBe("110.0000");

    // A SECOND code at a different rate, effective later — the version-by-effective-date shape the legacy
    // system had no way to express, which is why its rate lived in a procedure.
    await withTenant(db.rw, ctx, async (tx) => {
      await tx`
          insert into app.tax_code (tenant_id, company_id, regime_id, code, name_en, rate, kind,
                                    rounding_mode, output_account_id, effective_from)
          values (${f.s.tenant}, ${f.s.company}, ${f.regimeId}, 'SYN-OUT-STD-2', 'Second rate (synthetic)',
                  '0.20000000', 'output', 'HALF_AWAY_FROM_ZERO', ${f.accounts["2300"]!}, '2026-02-01')`;
    });
    const f2 = { ...f, codes: { ...f.codes } };
    const [second] = await withTenant(
      db.rw,
      ctx,
      (tx) => tx<{ id: string }[]>`
        select id from app.tax_code where company_id = ${f.s.company} and code = 'SYN-OUT-STD-2'`,
    );
    f2.codes["SYN-OUT-STD-2"] = second!.id;
    await postTaxedDocument(db, f2, {
      typeCode: "SALES_INVOICE",
      effectiveDate: "2026-02-10",
      taxInclusive: false,
      lines: [
        {
          lineNo: 1,
          accountId: f.accounts["4000"]!,
          amount: "1000.0000",
          taxCode: "SYN-OUT-STD-2",
        },
      ],
    });
    const after = await withTenant(db.rw, ctx, async (tx) => {
      const d = await createTaxReturn(tx, ctx, {
        companyId: f.s.company,
        regimeId: f.regimeId,
        periodStart: "2026-02-01",
        periodEnd: "2026-02-28",
      });
      return (await generateTaxReturn(tx, ctx, d.id)).boxes
        .find((b) => b.code === "S2")!
        .amount.toString();
    });
    expect(after).toBe("200.0000");
    // And January is unmoved — the old rate still applies to the old period, which is the whole point of
    // an effective-dated rate table and the thing a procedure literal cannot do.
    const january = await withTenant(db.rw, ctx, async (tx) => {
      const d = await createTaxReturn(tx, ctx, {
        companyId: f.s.company,
        regimeId: f.regimeId,
        periodStart: "2026-03-01",
        periodEnd: "2026-03-31",
      });
      await generateTaxReturn(tx, ctx, d.id);
      const rows = await tx<{ tax: string }[]>`
          select tax::text from app.tax_transaction
           where company_id = ${f.s.company} and effective_date = '2026-01-10'`;
      return rows[0]!.tax;
    });
    expect(january).toBe("110.0000");
  }, 180_000);

  it("no decimal literal that could be a rate exists in the tax engine or the tax services", () => {
    // The mechanical statement of the defect's first clause. Task 10's provenance guard makes the same
    // assertion over the same directories from `packages/db`'s own suite; both are cheap, and this is the
    // one a reader looking up LEGACY-020 will find.
    const hits = sourceFiles(["packages/domain/src/tax", "packages/db/src/tax"]).flatMap((f) =>
      f.lines.flatMap((line, i) =>
        /(^|[^\w.])0\.(?=[0-9]*[1-9])[0-9]{1,8}\b/.test(line) && !/^\s*(?:\*|\/\/)/.test(line)
          ? [`${f.path}:${i + 1}`]
          : [],
      ),
    );
    expect(hits).toEqual([]);
  });

  it("every tax code declares its regime, and a code outside its effective window refuses", async () => {
    const f = await taxFixture(db, "legacy020-window");
    const ctx = { tenantId: f.s.tenant, actorId: f.s.human, requestId: "legacy020-w" };
    const nulls = await withTenant(
      db.rw,
      ctx,
      (tx) => tx<{ n: number }[]>`
      select count(*)::int as n from app.tax_code
       where company_id = ${f.s.company} and regime_id is null`,
    );
    expect(nulls[0]!.n).toBe(0); // regime_id is NOT NULL in the DDL; this asserts the data too

    await withTenant(db.rw, ctx, async (tx) => {
      await tx`update app.tax_code set effective_to = '2026-01-05'
                where id = ${f.codes["SYN-OUT-STD"]!}`;
    });
    await expect(
      postTaxedDocument(db, f, {
        typeCode: "SALES_INVOICE",
        effectiveDate: "2026-01-10",
        taxInclusive: false,
        lines: [
          { lineNo: 1, accountId: f.accounts["4000"]!, amount: "100.0000", taxCode: "SYN-OUT-STD" },
        ],
      }),
    ).rejects.toMatchObject({ code: "ERR_TAX_REGIME_MISMATCH" });
    // "a refusal, not a wrong number" (spec:2444) — and the ambiguous-date half of the defect is answered
    // by the column type: `effective_from`/`effective_to` are `date`, compared to `document.effective_date`,
    // which is also `date`. There is no string date in this path to be ambiguous.
  }, 180_000);

  it("`kind` is a text CHECK owned by this table, not an enum shared with another meaning", async () => {
    const f = await taxFixture(db, "legacy020-enum");
    const ctx = { tenantId: f.s.tenant, actorId: f.s.human, requestId: "legacy020-e" };
    const rows = await withTenant(
      db.rw,
      ctx,
      (tx) =>
        tx<{ constraints: number; enums: number }[]>`
        select (select count(*)::int from pg_constraint
                 where conname = 'tax_code_kind_check') as constraints,
               (select count(*)::int from pg_type t join pg_enum e on e.enumtypid = t.oid
                 where e.enumlabel in ('output', 'input', 'exempt', 'zero', 'out_of_scope')) as enums`,
    );
    const { constraints, enums } = rows[0]!;
    expect(constraints).toBe(1);
    expect(enums).toBe(0); // hazard 11: no slice adds an enum label; a closed vocabulary is text + CHECK
  }, 180_000);
});

describe("LEGACY-020 — a return names its regime, and the regime is pinned at submission — 5B", () => {
  // LEGACY-020 in the legacy system: tax was recomputed from whatever rate table happened to be current,
  // so a reprint of an old return produced different numbers. 5A pins the regime on the RETURN. This
  // block adds 5B's half: the transmission is pinned to the regime the DOCUMENT carried, so a rate
  // change after transmission cannot move a transmitted invoice either.

  let db: Db;
  let stub: StubServer;
  // §4.1's `uuidv7(sql: Sql): Promise<string>` is async and takes a `Sql`, so it cannot be called
  // from a synchronous factory. One correlation id is minted in this block's `beforeAll` and reused;
  // a `requestId` is a correlation value, not a row id. BLOCK-SCOPED, because this file is 5A's.
  let requestId: string;
  const ctxOf = (s: Seed) => ({ tenantId: s.tenant, actorId: s.human, requestId });

  beforeAll(async () => {
    // The registry and the loopback server, exactly as tests/golden/tax-einvoice.test.ts sets them
    // up: a root `tests/` file starts no entrypoint, so nothing else fills the registry.
    db = await startDb();
    resetTransmitters();
    registerDefaultTransmitters("dev");
    requestId = await uuidv7(db.admin);
    stub = await startStubServer({
      submit: { state: "queued", receiptId: "LEGACY020-1" },
      poll: { state: "cleared" },
      cancel: { state: "withdrawn" },
    });
    registerTransmitter(
      "synthetic",
      createSyntheticTransmitter({
        profile: stub.profile,
        env: { EINVOICE_CLIENT_SECRET: "fixture-secret" },
      }),
    );
  }, 120_000);
  afterAll(async () => {
    await stub.stop();
    await db.stop();
  });

  it("pins the regime on the document's tax transactions, and transmitting does not consult a rate table", async () => {
    const f = await taxFixture(db, "legacy-020-5b");
    // ONE fixture per tenant. `einvoiceFixture` opts a document type in at `policyVersion + 1`, so
    // calling it twice on one tenant either bumps the version twice or violates the policy's unique
    // key — both are defects and neither is what this test is about.
    const e = await einvoiceFixture(db, f.s);
    const { documentId } = await postTaxedDocument(db, f, {
      typeCode: "SALES_INVOICE",
      effectiveDate: "2026-01-15",
      lines: [{ lineNo: 1, amount: "1000.0000", taxCode: "SYN-OUT-STD" }],
    });
    const before = await withTenant(db.rw, ctxOf(f.s), async (tx) => {
      const rows = await tx<{ regime_id: string; tax: string }[]>`
        select regime_id, tax::text from app.tax_transaction where document_id = ${documentId} order by line_no`;
      return rows;
    });
    expect(before.length).toBeGreaterThan(0);

    const [t] = await withTenant(db.rw, ctxOf(f.s), (tx) =>
      listTransmissions(tx, { companyId: f.s.company, limit: 1 }),
    );
    await e.driveToAccepted(t!.id);

    const after = await withTenant(
      db.rw,
      ctxOf(f.s),
      (tx) =>
        tx<{ regime_id: string; tax: string }[]>`
        select regime_id, tax::text from app.tax_transaction where document_id = ${documentId} order by line_no`,
    );
    // Transmission is a read of the document. If a tax_transaction row moved, something on the
    // e-invoicing path recomputed tax — which is LEGACY-020 reintroduced through a new door.
    expect(after).toEqual(before);
  });

  it("records the profile version the call was actually made with, so an incident is readable", async () => {
    const f = await taxFixture(db, "legacy-020-5b-version");
    const e = await einvoiceFixture(db, f.s);
    const { transmissionId } = await e.postOptedInDocument();
    await e.driveToAccepted(transmissionId);
    const [row] = await withTenant(db.rw, ctxOf(f.s), (tx) =>
      listTransmissions(tx, { companyId: f.s.company, limit: 1 }),
    );
    expect(row!.profileVersion).toBe(1);
    expect(row!.requestSha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("LEGACY-020 The GST return hardcodes a rate — 8B (the payroll half)", () => {
  it("no EXECUTABLE line under packages/domain/payroll holds a numeric literal that could be a rate", () => {
    // LEGACY-020's root cause is a figure in code. The structural fix is that every figure comes out of a RateTable, so
    // the package's executable source may hold `0` and `1` and nothing else numeric — a scale is MONEY_SCALE, a day
    // count is a named constant in period.ts, a rate is a table.
    //
    // Two strips, and each earns its place: (a) comments, which cite spec lines and LEGACY ids and would cry wolf on
    // every commit; (b) citations left in what remains — the thrown errors quote `spec:2080` inside template
    // literals. Every other digit inside every other string stays in scope, so a rate smuggled in as "0.11" is
    // still caught, and that is the LEGACY-020 shape that matters.
    const CITATION = /(spec:\d+|LEGACY-\d+|OD-\d+|RC-\d+)/g;
    const BLOCK_COMMENT = /\/\*[\s\S]*?\*\//g;
    const LINE_COMMENT = /(^|[^:])\/\/[^\n]*/g; // the `[^:]` spares `https://`
    const strip = (src: string) =>
      src.replace(BLOCK_COMMENT, " ").replace(LINE_COMMENT, "$1").replace(CITATION, " ");
    // period.ts is excluded here and checked structurally below: it counts days, so `86_400_000`, SUNDAY and SATURDAY
    // are legitimate, and an allowlist wide enough to admit them is wide enough to admit a contribution rate.
    const files = [
      "index",
      "types",
      "errors",
      "calculator",
      "schemes/index",
      "schemes/shape",
      "schemes/banded-contribution",
      "schemes/percentage-with-ceiling",
      "schemes/progressive-schedule",
    ];
    for (const f of files) {
      const text = strip(repoFile(`packages/domain/payroll/${f}.ts`));
      const literals = [...text.matchAll(/(?<![\w.])(\d[\d_]*(?:\.\d+)?)(?![\w.])/g)]
        .map((mm) => mm[1]!)
        .filter((v) => !["0", "1"].includes(v));
      expect(literals, `${f}.ts holds numeric literals ${literals.join(", ")}`).toEqual([]);
    }
    // And the list above is the whole executable package, so a new file cannot slip past the scan.
    const shipped = sourceFiles(["packages/domain/payroll"])
      .map((f) => f.path.replace(/^packages\/domain\/payroll\//, "").replace(/\.ts$/, ""))
      .filter((p) => !["period", "rate-table", "validate"].includes(p) && !p.endsWith(".json"));
    expect(shipped.toSorted()).toEqual(files.toSorted());
  });

  it("period.ts cannot express a rate at all — it holds no Money and no Decimal", () => {
    // The structural half of the rule above. A file that never imports the money types cannot carry a contribution
    // rate whatever its numbers say, and its three constants are calendar facts by name.
    const text = repoFile("packages/domain/payroll/period.ts");
    expect(text).not.toMatch(/decimal\.js/);
    expect(text).not.toMatch(/Money/);
    expect([...text.matchAll(/^const ([A-Z_]+) =/gm)].map((mm) => mm[1]!).toSorted()).toEqual([
      "MS_PER_DAY",
      "SATURDAY",
      "SUNDAY",
    ]);
  });

  it("an out-of-range table refuses the run rather than computing with the wrong version", () => {
    expect(() =>
      payrollCalculator.calculate({
        period: {
          start: "2026-01-01",
          end: "2026-01-31",
          payDate: "2026-02-05",
          prorationRule: "calendar_days",
        },
        employees: [],
        rateTables: [
          {
            schemeId: "s",
            schemeCode: "SYNTH",
            version: 2,
            effectiveFrom: "2026-02-01",
            effectiveTo: null,
            verified: true,
            definition: {
              schema_version: 1,
              scheme: "SYNTH",
              version: 2,
              kind: "banded_contribution",
              effective_from: "2026-02-01",
              effective_to: null,
              source: {
                authority: "Dulja test fixture",
                publication: "none",
                url: "https://example.invalid/s",
                retrieved_on: "2026-01-01",
              },
              table: { bands: [{ from: "0", to: null, employee: "1.0000", employer: "1.0000" }] },
            },
          },
        ],
        ytdBefore: {},
      }),
    ).toThrow(PayrollCalculationError);
  });
});

describe("LEGACY-020 The GST return hardcodes a rate — 8D (the payroll outputs)", () => {
  // Every 8D source that computes or prints a payroll figure. A payslip, a register or a reconciliation reads its
  // figures from posted lines; none may hold a rate of its own.
  const FILES = [
    "packages/db/src/reports/datasets/hr.ts",
    "packages/db/src/hr/payslip.ts",
    "packages/db/src/hr/reconcile.ts",
    "packages/db/src/hr/rotate.ts",
    "packages/db/src/hr/permit-expiry.ts",
    "packages/db/src/hr/leave.ts",
    "apps/api/src/print/payslip.ts",
  ];
  const DIR = join(REPO_ROOT, "packages/db/seed/my/reports/8d");
  const definitions = () => readdirSync(DIR).filter((n) => n.endsWith(".json"));

  it("no 8D source file contains a percentage or contribution literal", () => {
    for (const path of FILES) {
      const text = repoFile(path);
      // A bare decimal multiplied or divided in, or a `/ 100`, is what a rate looks like in code.
      expect(text, path).not.toMatch(/[*/]\s*0?\.\d/);
      expect(text, path).not.toMatch(/\/\s*100\b/);
    }
  });

  it("no 8D report definition carries a numeric value — every figure comes from the data", () => {
    expect(definitions().length).toBe(8);
    for (const name of definitions()) {
      const def = (JSON.parse(readFileSync(join(DIR, name), "utf8")) as { definition: unknown })
        .definition;
      // The format's `version` and each column's `width` are the only numbers a definition may carry.
      const numbers: string[] = [];
      JSON.stringify(def, (key, value: unknown) => {
        if (typeof value === "number" && key !== "version" && key !== "width") {
          numbers.push(`${key}=${value}`);
        }
        return value;
      });
      expect(numbers, name).toEqual([]);
    }
  });

  it("the only statutory identifiers 8D names are COLUMNS, never scheme values", () => {
    const text = repoFile("packages/db/src/reports/datasets/hr.ts");
    expect(text).toContain("scheme_code");
    expect(text).toContain("rate_table_version");
    const corpus = [
      ...FILES.map((f) => repoFile(f)),
      ...definitions().map((n) => readFileSync(join(DIR, n), "utf8")),
    ].join("\n");
    for (const scheme of ["EPF", "SOCSO", "EIS", "PCB"]) {
      expect(corpus, scheme).not.toMatch(new RegExp(`\\b${scheme}\\b`));
    }
  });
});

// The "shares an enum with an incompatible meaning" half, met again by the 2026-11-15 full review (MON-04): a
// code's KIND (`exempt`, `zero`) was read as if it said which side of the return a fact is on. It does not — a
// zero-rated or exempt code is used on sales and purchases alike — so the side is the DOCUMENT's.
describe("LEGACY-020 — a tax fact is boxed on its document's side, not its code's kind — 2026-11-15 review", () => {
  it("an exempt purchase is in no supplies box, and an exempt sale still is", async () => {
    const { currency, Money, malaysiaPack } = await import("@dulja/domain");
    const MYR = currency("MYR");
    const m = (v: string) => Money.of(v, MYR);
    const row = (documentTypeCode: string, side: "output" | "input", amount: string) => ({
      documentId: `d-${documentTypeCode}`,
      documentTypeCode,
      lineNo: 1,
      taxCodeId: "c-exempt",
      taxCode: "SYN-EXEMPT",
      regimeId: "r-1",
      kind: "exempt" as const,
      rate: "0.00000000",
      base: m(amount),
      tax: m("0.0000"),
      baseBase: m(amount),
      taxBase: m("0.0000"),
      effectiveDate: "2026-03-20",
      postingSeq: "1",
      side,
    });
    const { boxes } = malaysiaPack.buildReturn({
      regime: {
        id: "r-1",
        code: "SYNTH-MY-v1",
        jurisdiction: "MY",
        version: 1,
        effectiveFrom: "2026-01-01",
        effectiveTo: null,
      },
      periodStart: "2026-01-01",
      periodEnd: "2026-03-31",
      transactions: [
        row("PURCHASE_INVOICE", "input", "400.0000"),
        row("SALES_INVOICE", "output", "150.0000"),
      ],
    });
    expect(boxes.find((b) => b.code === "S3")!.amount.toString()).toBe("150.0000");
  });

  it("a code that declares the other side is refused; one that declares none takes the document's", async () => {
    const { contradictsSide } = await import("@dulja/domain");
    expect(contradictsSide("input", "output")).toBe(true);
    expect(contradictsSide("output", "input")).toBe(true);
    expect(contradictsSide("exempt", "input")).toBe(false);
    expect(contradictsSide("zero", "output")).toBe(false);
    expect(contradictsSide("input", null)).toBe(false);
  });
});
