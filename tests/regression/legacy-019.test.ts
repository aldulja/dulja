import { sourceFiles } from "../support/source";
import Decimal from "decimal.js";
import type { Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { taxEngine, Money, currency, round, type RoundingMode } from "@dulja/domain";
import { calculators, type PayPeriod, type RateTable } from "@dulja/domain/payroll";
import { generateStatutorySchedule, MemoryObjectStore, scheduleCsv, withTenant } from "@dulja/db";
import {
  seedCurrency,
  seedTenant,
  seedTenantV2,
  startDb,
  uuidv7,
  type Db,
  type Seed,
} from "@dulja/db/test";
import { repoFile, sharedDb } from "../support/regression";
import { moneyOutFixture, type MoneyOutFixture } from "../invariants/support/payroll-money";

const MYR = currency("MYR");
const MODES: RoundingMode[] = ["HALF_AWAY_FROM_ZERO", "HALF_EVEN", "TOWARD_ZERO", "AWAY_FROM_ZERO"];
describe("LEGACY-019 explicit symmetric rounding — 0D", () => {
  let db: Db;
  let seed: Seed;
  beforeAll(async () => {
    db = await startDb();
    seed = await seedTenant(db, "Alpha");
  });
  afterAll(async () => {
    await db.stop();
  });

  /** Root `tests/` uses the production `withTenant`; this mints the `requestId` its `TenantContext` needs. */
  const asHuman = async <T>(fn: (tx: Sql) => Promise<T>): Promise<T> =>
    withTenant(
      db.rw,
      { tenantId: seed.tenant, actorId: seed.human, requestId: await uuidv7(db.admin) },
      fn,
    );

  it("keeps every rounding mode symmetric across sign", () => {
    for (const mode of MODES)
      expect(round(new Decimal("-2.50005"), 4, mode).toFixed(4)).toBe(
        `-${round(new Decimal("2.50005"), 4, mode).toFixed(4)}`,
      );
  });
  it("requires an explicit arithmetic mode", () => {
    // The proof is the compile error, not a throw: `bun run typecheck` fails with TS2578 "Unused
    // '@ts-expect-error' directive." the day `mode` becomes optional. At *run* time an absent mode is
    // `undefined`, which decimal.js reads as "use the constructor default" — it does not raise.
    // @ts-expect-error the mode is required
    Money.of("10", MYR).multiply("3");
    // @ts-expect-error — and on divide, for the same reason
    Money.of("10", MYR).divide("3");
    expect(Money.of("10", MYR).multiply("3", "HALF_EVEN").toString()).toBe("30.0000");
    expect(Money.of("10", MYR).divide("4", "HALF_EVEN").toString()).toBe("2.5000");
  });
  it("stores rounding policy per currency", async () => {
    // MYR arrives with the tenant — seedTenant must create it, because 0008 made
    // company.base_currency a foreign key. Only the second currency is this test's to seed.
    await seedCurrency(db, seed, { code: "JPY", minorUnit: 0 });
    const rows = await asHuman(
      (tx) =>
        tx<
          { code: string; minor_units: number; rounding_mode: string }[]
        >`select code, minor_units, rounding_mode from app.currency order by code`,
    );
    // The exact rows, so the `minor_units: 0` this test seeds for JPY is actually verified and not merely
    // implied by the set of codes.
    expect(rows).toEqual([
      { code: "JPY", minor_units: 0, rounding_mode: "HALF_AWAY_FROM_ZERO" },
      { code: "MYR", minor_units: 2, rounding_mode: "HALF_AWAY_FROM_ZERO" },
    ]);
  });

  it("the recorded rule is a value the domain layer can actually use — the four literals agree", async () => {
    // `rounding_mode` is a text column with a CHECK, not an enum (migration 0005 keeps enum extension out of the
    // schema), so the authority is the constraint definition. Read it from the catalog on `db.admin`.
    const [row] = await db.admin<{ def: string }[]>`
      select pg_get_constraintdef(oid) as def
        from pg_constraint
       where conrelid = 'app.currency'::regclass and conname like '%rounding_mode%'`;
    expect(row, "no CHECK constraint on app.currency.rounding_mode").toBeDefined();
    // pg_get_constraintdef prints the IN list as
    //   CHECK ((rounding_mode = ANY (ARRAY['HALF_AWAY_FROM_ZERO'::text, 'HALF_EVEN'::text,
    //                                       'TOWARD_ZERO'::text, 'AWAY_FROM_ZERO'::text])))
    // so every quoted upper-case literal in it is one accepted mode, and there are exactly four.
    const accepted = [...row!.def.matchAll(/'([A-Z_]+)'/g)].map((match) => match[1]!);
    expect(new Set(accepted)).toEqual(new Set(MODES));
    expect(accepted).toHaveLength(MODES.length);
  });

  it("stored amounts are never re-rounded on read", async () => {
    // 0008: exchange_rate.from_currency is a foreign key, so the pair has to exist before the rate.
    // Seeded here rather than in beforeAll so the exact-rows assertion above keeps its meaning.
    await seedCurrency(db, seed, { code: "USD" });
    await asHuman(
      (tx) => tx`
      insert into app.exchange_rate (tenant_id, company_id, from_currency, to_currency, rate, effective_from, source)
      values (${seed.tenant}, ${seed.company}, 'USD', 'MYR', 4.68123456, '2026-01-01', 'legacy-019')`,
    );
    const [row] = await asHuman(
      (tx) => tx<{ rate: string }[]>`
      select rate::text from app.exchange_rate where source = 'legacy-019'`,
    );
    expect(row!.rate).toBe("4.68123456"); // eight places, unchanged, on every read
  });
});

// ─── 4A ──────────────────────────────────────────────────────────────────────────────────────────────────
// contracts §3.7.3: appended, create-if-absent — the catalogue names no creator for this file (0D's block
// above landed first), so the block is order-independent and never edits the one above it.
describe("LEGACY-019 One rounding function, one mode, symmetric across sign — 4A", () => {
  it("this slice names ONE rounding mode and no rounding surface of its own", () => {
    for (const f of [
      "packages/db/src/ar-ap/allocation.ts",
      "packages/db/src/ar-ap/invoice.ts",
      "packages/db/src/ar-ap/credit-note.ts",
    ]) {
      const src = repoFile(f);
      // The legacy defect was eight configured rounding columns, zero references, and a function that
      // returned 10 when rounding 8 down to base 5. The structural fix here is that these files own NO
      // rounding surface: `decimal.js` is packages/domain's dependency (§4.2.1, D11) and nothing under
      // packages/db/src imports it, so the only mode any of them can name is the one `Money` is given.
      expect(src, f).not.toMatch(/from "decimal\.js"/);
      // Every rounding mode reaches `Money` as a quoted `RoundingMode` literal (§4.2.1), so the quoted
      // occurrences are the complete set of modes the file can use. Prose in a comment is not matched.
      for (const m of src.match(/"(HALF_AWAY_FROM_ZERO|HALF_EVEN|TOWARD_ZERO|AWAY_FROM_ZERO)"/g) ??
        []) {
        expect(m, f).toBe('"HALF_AWAY_FROM_ZERO"');
      }
    }
  });

  it("every base conversion in this slice goes through `toBase` and none is hand-rolled", () => {
    const src = repoFile("packages/db/src/ar-ap/allocation.ts");
    // Global Constraint 5: `allocation.ts` is the one file in this slice that converts to base, and it does
    // so through `toBase` — `round(value × rate, 4)` HALF_AWAY_FROM_ZERO, the identity ledger_entry's CHECK
    // enforces (spec:1816). Anchored on CODE shapes: `.times(` is decimal.js's multiply and `multiply(` with a
    // rate argument is Money's; a comment that writes the identity out is not a second implementation.
    expect(src).toMatch(/toBase\(/);
    expect(src).not.toMatch(/\.times\(/);
    expect(src).not.toMatch(/multiply\([^)]*[eE]xchange_?[rR]ate/);
  });

  it("the base identity is the database's own CHECK on every ledger row, and no row breaks it", async () => {
    const { db } = await sharedDb();
    // The identity holds on every row any slice posts, in both signs, because the table refuses anything
    // else: amounts are non-negative magnitudes and `side` carries the sign (§4.4.2 A9).
    const defs = (
      await db.admin<{ def: string }[]>`
        select pg_get_constraintdef(oid) as def from pg_constraint
         where conrelid = 'app.ledger_entry'::regclass and contype = 'c'`
    ).map((r) => r.def);
    expect(defs.some((d) => /base_debit = round\(\(debit \* exchange_rate\), 4\)/.test(d))).toBe(
      true,
    );
    expect(defs.some((d) => /base_credit = round\(\(credit \* exchange_rate\), 4\)/.test(d))).toBe(
      true,
    );
    const [n] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from app.ledger_entry
       where base_debit <> round(debit * exchange_rate, 4) or base_credit <> round(credit * exchange_rate, 4)`;
    expect(n!.n).toBe(0);
  });
});

// 4B (contracts §3.7.3: appended, never editing a block above).
describe("LEGACY-019 One rounding function, explicit mode, symmetric across sign — 4B", () => {
  it("the FX services own no rounding surface: every base figure is toBase's or a sum of stored ones", () => {
    // CODE only: the comments write the identity out as prose ("round(value × rate, 4)"), which is not a
    // second implementation.
    const src = repoFile("packages/db/src/ar-ap/fx.ts")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    // The legacy defect was a rounding function of its own that returned 10 when rounding 8 down to base 5.
    // fx.ts can have none: it imports no decimal.js, calls no round() and no toFixed(), and declares no
    // function whose name starts with round — the one conversion is toBase (HALF_AWAY_FROM_ZERO, §4.2.1),
    // and every other figure is a Money sum of numeric(19,4) values Postgres returned.
    expect(src).toMatch(/from "@dulja\/domain"/);
    expect(src).not.toMatch(/from "decimal\.js"/);
    expect(src).not.toMatch(/\bround\(/);
    expect(src).not.toMatch(/\.toFixed\(/);
    expect(src).not.toMatch(/function\s+round\w*\s*\(/);
    expect(src).toMatch(/toBase\(/);
    // No quoted rounding mode at all: the mode is the one toBase fixes, not a choice this file makes.
    expect(src).not.toMatch(/"(HALF_AWAY_FROM_ZERO|HALF_EVEN|TOWARD_ZERO|AWAY_FROM_ZERO)"/);
  });
});

// ── appended by slice 5A ─────────────────────────────────────────────────────────────────────────────
const codeAt = (mode: RoundingMode) => ({
  id: "88888888-8888-7888-8888-888888888888",
  regimeId: "99999999-9999-7999-8999-999999999999",
  code: "SYN-OUT-STD",
  rate: "0.11000000",
  kind: "output" as const,
  roundingMode: mode,
  outputAccountId: null,
  inputAccountId: null,
  effectiveFrom: "2026-01-01",
  effectiveTo: null,
});

describe("LEGACY-019 Rounding is configured everywhere, applied nowhere, and the function is wrong — 5A", () => {
  const ccy = currency("MYR");

  const regime = {
    id: "99999999-9999-7999-8999-999999999999",
    code: "SYNTH-MY-v1",
    jurisdiction: "MY" as const,
    version: 1,
    effectiveFrom: "2026-01-01",
    effectiveTo: null,
  };

  it("the declared mode is APPLIED: two codes differing only in rounding_mode give different tax", () => {
    // The defect's headline: ten rounding columns across `Currencies` and `TaxCodes` with ZERO references.
    // 10.0500 x 0.11 = 1.1055 exactly, so at scale 4 there is nothing to round and every mode agrees --
    // asserted first, because a test whose two modes always differ proves nothing about which one ran.
    const base = Money.of("10.0500", ccy);
    const half = taxEngine.compute(regime, [
      { lineNo: 1, amount: base, taxCode: codeAt("HALF_AWAY_FROM_ZERO"), inclusive: false },
    ]);
    const toward = taxEngine.compute(regime, [
      { lineNo: 1, amount: base, taxCode: codeAt("TOWARD_ZERO"), inclusive: false },
    ]);
    expect(half[0]!.tax.toString()).toBe("1.1055");
    expect(toward[0]!.tax.toString()).toBe("1.1055");
    // Now push the base until the modes MUST part: 10.0509 x 0.11 = 1.105599, whose fifth decimal is 9.
    const finer = Money.of("10.0509", ccy);
    const h2 = taxEngine.compute(regime, [
      { lineNo: 1, amount: finer, taxCode: codeAt("HALF_AWAY_FROM_ZERO"), inclusive: false },
    ]);
    const t2 = taxEngine.compute(regime, [
      { lineNo: 1, amount: finer, taxCode: codeAt("TOWARD_ZERO"), inclusive: false },
    ]);
    expect(h2[0]!.tax.toString()).toBe("1.1056");
    expect(t2[0]!.tax.toString()).toBe("1.1055");
    expect(h2[0]!.tax.toString()).not.toBe(t2[0]!.tax.toString());
  });

  it("rounding is symmetric across sign — the +6/-6 asymmetry that left a 5-unit imbalance per credit note", () => {
    // `RoundTo.sql` returned +10 for +6 and -5 for -6. Every mode here must be sign-symmetric in
    // MAGNITUDE for HALF_AWAY_FROM_ZERO, which is the mode every shipped code declares.
    const plus = taxEngine.compute(regime, [
      {
        lineNo: 1,
        amount: Money.of("10.0509", ccy),
        taxCode: codeAt("HALF_AWAY_FROM_ZERO"),
        inclusive: false,
      },
    ]);
    const minus = taxEngine.compute(regime, [
      {
        lineNo: 1,
        amount: Money.of("-10.0509", ccy),
        taxCode: codeAt("HALF_AWAY_FROM_ZERO"),
        inclusive: false,
      },
    ]);
    expect(minus[0]!.tax.toString()).toBe(`-${plus[0]!.tax.toString()}`);
    expect(minus[0]!.base.toString()).toBe(`-${plus[0]!.base.toString()}`);
  });

  it("a null base is not expressible, and a rounded figure is never rounded twice", () => {
    // `vRoundBase is NULL` bypassed the `= 0` guard and returned NULL, silently nulling the amount.
    // `Money` has no null state and `TaxLineInput.amount` is a `Money`, so the branch cannot exist.
    // And an inclusive line's base + tax is EXACTLY the entered figure — no residue, no second rounding.
    const r = taxEngine.compute(regime, [
      {
        lineNo: 1,
        amount: Money.of("1110.0000", ccy),
        taxCode: codeAt("HALF_AWAY_FROM_ZERO"),
        inclusive: true,
      },
    ]);
    expect(r[0]!.base.add(r[0]!.tax).toString()).toBe("1110.0000");
    expect(r[0]!.base.toString()).toBe("1000.0000");
    expect(r[0]!.tax.toString()).toBe("110.0000");
  });

  it("there is exactly one rounding function: no Math.round and no local round in either tax directory", () => {
    const offenders = sourceFiles(["packages/domain/src/tax", "packages/db/src/tax"]).flatMap((f) =>
      f.lines.flatMap((line, i) =>
        /\bMath\.(round|floor|ceil|trunc)\b|\bfunction\s+round\b|\.toFixed\s*\(/.test(line)
          ? [`${f.path}:${i + 1} ${line.trim()}`]
          : [],
      ),
    );
    expect(offenders).toEqual([]);
  });
});

describe("LEGACY-019 — no local rounding and no float on the e-invoice path — 5B", () => {
  const SURFACE = [
    "packages/db/src/einvoice",
    "packages/domain/src/tax/einvoice.ts",
    "apps/api/src/routes/accounting/einvoice-transmissions.ts",
    "apps/worker/src/handlers/accounting-tax-submit.ts",
    "packages/contracts/src/accounting/einvoice.ts",
  ];

  it("names no toFixed, no Number(), no parseFloat and no Math.round anywhere on the surface", () => {
    const offenders: string[] = [];
    // `sourceFiles(roots)` walks DIRECTORIES (0B: `readdirSync(join(REPO_ROOT, root))` per root), so
    // the roots are the two workspace trees and SURFACE is applied as a path filter afterwards.
    for (const file of sourceFiles(["packages", "apps"]).filter((f) =>
      SURFACE.some((s) => f.path === s || f.path.startsWith(`${s}/`)),
    )) {
      // `SourceFile { path; text; lines }` (§4.17.1) — `lines` is already the split text, so this
      // loop reads nothing from disk of its own.
      for (const [i, line] of file.lines.entries()) {
        if (
          /\.toFixed\(|\bparseFloat\(|\bMath\.round\(|\bNumber\(/.test(line) &&
          !line.trimStart().startsWith("//")
        ) {
          offenders.push(`${file.path}:${i + 1}: ${line.trim()}`);
        }
      }
    }
    // Every amount on this path is a Money fixed-scale string taken from LineSnapshot and passed
    // through unchanged (Global Constraint 4). A single Number() here would round MYR 1234.5678 to a
    // double and reintroduce LEGACY-019 at the one place the customer's regulator reads.
    expect(offenders).toEqual([]);
  });

  it("declares no numeric money column and no float column on einvoice_transmission", async () => {
    const { db } = await sharedDb();
    const cols = await db.admin<{ column_name: string; data_type: string }[]>`
      select column_name, data_type from information_schema.columns
       where table_schema = 'app' and table_name = 'einvoice_transmission'
       order by column_name`;
    const numeric = cols.filter((c) =>
      ["numeric", "real", "double precision"].includes(c.data_type),
    );
    // The log carries no amount at all: the amounts live on the document it points at, and a second
    // copy is a second thing that can disagree.
    expect(numeric.map((c) => c.column_name)).toEqual([]);
  });
});

// Invented figures (hazard 1): a 0.5 share of a 0.0001 base, so the fourth decimal is a tie the MODE decides.
const payrollTable = (mode: RoundingMode): RateTable => ({
  schema_version: 1,
  scheme: "SYNTH_ROUND",
  version: 1,
  kind: "percentage_with_ceiling",
  effective_from: "2026-01-01",
  effective_to: null,
  source: {
    authority: "Dulja test fixture",
    publication: "none",
    url: "https://example.invalid/r",
    retrieved_on: "2026-01-01",
  },
  rounding_mode: mode,
  table: { employee_rate: "0.5", employer_rate: "0.5", ceiling: null, floor: null },
});

describe("LEGACY-019 Rounding is configured everywhere, applied nowhere, and the one rounding function is wrong — 8B", () => {
  const period: PayPeriod = {
    start: "2026-01-01",
    end: "2026-01-31",
    payDate: "2026-02-05",
    prorationRule: "calendar_days",
  };
  const share = (mode: RoundingMode, base: string) =>
    calculators.percentage_with_ceiling.compute(payrollTable(mode), {
      base: Money.of(base, MYR),
      profile: {},
      ytd: {},
      period,
    }).employeeShare;

  it("the scheme's declared mode is what is applied, and it is symmetric across sign", () => {
    // 0.0001 × 0.5 = 0.00005 → the fourth decimal is decided by the MODE and by nothing else.
    expect(share("AWAY_FROM_ZERO", "0.0001").toString()).toBe("0.0001");
    expect(share("TOWARD_ZERO", "0.0001").toString()).toBe("0.0000");
    for (const mode of MODES)
      expect(share(mode, "-0.0003").toString()).toBe(
        share(mode, "0.0003").isZero() ? "0.0000" : `-${share(mode, "0.0003").toString()}`,
      );
  });

  it("there is exactly ONE rounding implementation reachable from the payroll package", () => {
    // The legacy system had a rounding setting per screen and a rounding function that was wrong. The fix is
    // structural: every calculator calls Money.fromDecimal, which calls @dulja/domain's one `round`.
    for (const f of ["banded-contribution", "percentage-with-ceiling", "progressive-schedule"]) {
      const text = repoFile(`packages/domain/payroll/schemes/${f}.ts`);
      expect(text).toContain("Money.fromDecimal");
      expect(text).not.toMatch(/\.toFixed\(4\)|Math\.round|toDecimalPlaces\(/);
    }
  });
});

describe("LEGACY-019 Rounding is configured everywhere, applied nowhere — 8C", () => {
  // Only the Db is taken from the shared context; the block seeds its own tenant (payrollFixture is not idempotent).
  let db: Db;
  let s: Seed;
  let f: MoneyOutFixture;
  let schedule: Awaited<ReturnType<typeof generateStatutorySchedule>>[number];
  let payableAccountId: string;

  beforeAll(async () => {
    db = (await sharedDb()).db;
    s = await seedTenantV2(db, "LEGACY-019 8C");
    f = await moneyOutFixture(db, s);
    const ctx = {
      tenantId: s.tenant,
      actorId: s.human,
      requestId: "00000000-0000-0000-0000-000000000000",
    };
    const [generated] = await withTenant(db.rw, ctx, (tx) =>
      generateStatutorySchedule(tx, ctx, new MemoryObjectStore(), {
        companyId: s.company,
        payrollDocumentId: f.payrollDocumentId,
      }),
    );
    schedule = generated!;
    const [scheme] = await db.admin<{ payable_account_id: string }[]>`
      select payable_account_id from app.statutory_scheme where id = ${f.schemeId}`;
    payableAccountId = scheme!.payable_account_id;
  }, 240_000);

  it("every figure on a schedule is a fixed-scale 4-dp string, never a float rendered late", () => {
    expect(schedule.totalEmployee.toString()).toMatch(/^-?\d+\.\d{4}$/);
    expect(schedule.totalEmployer.toString()).toMatch(/^-?\d+\.\d{4}$/);
    expect(schedule.rows.length).toBeGreaterThan(0);
    for (const row of schedule.rows) {
      expect(row.employeeShare).toMatch(/^-?\d+\.\d{4}$/);
      expect(row.employerShare).toMatch(/^-?\d+\.\d{4}$/);
    }
  });

  it("the CSV carries those same strings — no Number, toFixed or locale formatting reaches it", () => {
    const csv = scheduleCsv(schedule);
    const body = csv
      .split("\r\n")
      .slice(1)
      .filter((l) => l.length > 0);
    expect(body).toHaveLength(schedule.rows.length);
    for (const [i, line] of body.entries()) {
      const cells = line.split(",");
      // Five cells exactly: a thousands separator inside a figure would split it into a sixth.
      expect(cells).toHaveLength(5);
      expect(cells.at(-2)).toBe(schedule.rows[i]!.employeeShare);
      expect(cells.at(-1)).toBe(schedule.rows[i]!.employerShare);
      // …and each figure at exactly four decimals, never fewer.
      for (const figure of cells.slice(-2)) expect(figure).toMatch(/^-?\d+\.\d{4}$/);
    }
  });

  it("the schedule total equals the ledger movement as a STRING — which is what 'applied' means", async () => {
    const [row] = await db.admin<{ amount: string }[]>`
      select to_char(coalesce(sum(le.base_credit) - sum(le.base_debit), 0), 'FM999999999999990.0000') as amount
        from app.ledger_entry le
       where le.document_id = ${f.payrollDocumentId} and le.account_id = ${payableAccountId}`;
    // Not toBeCloseTo: two figures that round differently are two figures, and that is the whole of LEGACY-019.
    expect(schedule.totalEmployee.add(schedule.totalEmployer).toString()).toBe(row!.amount);
  });
});
