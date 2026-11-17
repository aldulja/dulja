// tests/golden/tax.test.ts — acceptance test 26 (spec:2444) and the whole Phase 5 definition of done.
//
// Amendment A10: for the tax area, `expected.json` is a TaxGoldenExpectation and `input.json` is a
// GoldenCase whose documents name their codes, accounts and parties SYMBOLICALLY, because every id in
// this fixture is a per-run uuid. There is no `policies.json`: `taxFixture` reads the four 4A
// document-type envelopes off disk through `seedTypeFromPack`, and a second copy of them here would be
// two spellings of one thing (hazard 9).
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { withTenant } from "@dulja/db";
import {
  createTaxReturn,
  generateTaxReturn,
  getTaxReturn,
  taxReturnTieOut,
  type TaxReturnTieOutRow,
} from "@dulja/db";
import { canonicalJson, malaysiaPack, Money, currency, SYNTH_MY_V1 } from "@dulja/domain";
import { seedTaxCode, startDb, type Db } from "@dulja/db/test";
import { postTaxedDocument, taxFixture, type TaxFixture } from "../invariants/support/tax";

const DIR = fileURLToPath(new URL("./tax/", import.meta.url));
const CASES = ["synth-my-quarter", "synth-my-inclusive"] as const;

export interface GoldenBox {
  code: string;
  label: string;
  amount: string;
}
export interface GoldenLine {
  lineNo: number;
  accountCode: string;
  amount: string;
  taxCode: string | null;
}
export interface GoldenDocument {
  typeCode: "SALES_INVOICE" | "SALES_CREDIT_NOTE" | "PURCHASE_INVOICE" | "PURCHASE_CREDIT_NOTE";
  effectiveDate: string;
  party: "customer" | "vendor";
  taxInclusive: boolean;
  lines: GoldenLine[];
}
export interface GoldenCase {
  regimeCode: string;
  regimeVersion: number;
  periodStart: string;
  periodEnd: string;
  documents: GoldenDocument[];
}
export interface TaxGoldenExpectation {
  boxes: GoldenBox[];
  payload: string;
  payloadSha256: string;
  tieOut: TaxReturnTieOutRow[];
}

function readCase(name: string): GoldenCase {
  return JSON.parse(readFileSync(join(DIR, name, "input.json"), "utf8")) as GoldenCase;
}

/**
 * Drives one case end to end and returns exactly what `expected.json` holds. **No assertion lives in
 * here** — the harness produces, the tests compare, and `UPDATE_GOLDEN=1` writes. A generated expected
 * file nobody read is a snapshot of whatever the code did, so Step 5 reads them against a hand table.
 */
async function runGoldenCase(
  db: Db,
  name: string,
  input: GoldenCase,
): Promise<TaxGoldenExpectation> {
  const f: TaxFixture = await taxFixture(db, name);
  for (const d of input.documents) {
    await postTaxedDocument(db, f, {
      typeCode: d.typeCode,
      effectiveDate: d.effectiveDate,
      partyId: d.party === "customer" ? f.customerId : f.vendorId,
      taxInclusive: d.taxInclusive,
      lines: d.lines.map((l) => ({
        lineNo: l.lineNo,
        kind: "account",
        accountId: f.accounts[l.accountCode]!,
        amount: l.amount,
        taxCode: l.taxCode,
      })),
    });
  }
  const ctx = { tenantId: f.s.tenant, actorId: f.s.human, requestId: `golden-${name}` };
  return withTenant(db.rw, ctx, async (tx) => {
    const draft = await createTaxReturn(tx, ctx, {
      companyId: f.s.company,
      regimeId: f.regimeId,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
    });
    const { row, boxes } = await generateTaxReturn(tx, ctx, draft.id);
    const tieOut = await taxReturnTieOut(tx, draft.id);
    return {
      boxes: boxes.map((b) => ({ code: b.code, label: b.label, amount: b.amount.toString() })),
      payload: row.payload!,
      payloadSha256: row.payloadSha256!,
      tieOut,
    };
  });
}

describe("acceptance test 26 — tax return determinism (spec:2444; LEGACY-020, 058, 059)", () => {
  let db: Db;
  beforeAll(async () => {
    db = await startDb();
  }, 180_000);
  afterAll(async () => {
    await db.stop();
  });

  it("every case directory holds exactly input.json and expected.json", () => {
    // A10: no `policies.json` in this area. An extra file here means someone copied 3B's layout.
    for (const c of CASES) {
      expect(readdirSync(join(DIR, c)).toSorted()).toEqual(["expected.json", "input.json"]);
    }
  });

  for (const name of CASES) {
    it(`${name} matches expected.json byte for byte`, async () => {
      const actual = await runGoldenCase(db, name, readCase(name));
      if (process.env.UPDATE_GOLDEN === "1") {
        writeFileSync(join(DIR, name, "expected.json"), `${JSON.stringify(actual, null, 2)}\n`);
      }
      const expected = JSON.parse(
        readFileSync(join(DIR, name, "expected.json"), "utf8"),
      ) as TaxGoldenExpectation;
      expect(JSON.stringify(actual, null, 2)).toBe(JSON.stringify(expected, null, 2));
    }, 180_000);
  }
});

describe("test 26 clauses beyond the byte-compare", () => {
  let db: Db;
  beforeAll(async () => {
    db = await startDb();
  }, 180_000);
  afterAll(async () => {
    await db.stop();
  });

  // ── Clause 1: "byte-identical across runs" ──────────────────────────────────────────────────────────
  it("regenerating the same period produces the identical sha, and a later period does not disturb it", async () => {
    const input = readCase("synth-my-quarter");
    const f = await taxFixture(db, "t26-determinism");
    for (const d of input.documents) {
      await postTaxedDocument(db, f, {
        typeCode: d.typeCode,
        effectiveDate: d.effectiveDate,
        partyId: d.party === "customer" ? f.customerId : f.vendorId,
        taxInclusive: d.taxInclusive,
        lines: d.lines.map((l) => ({
          lineNo: l.lineNo,
          kind: "account" as const,
          accountId: f.accounts[l.accountCode]!,
          amount: l.amount,
          taxCode: l.taxCode,
        })),
      });
    }
    const ctx = { tenantId: f.s.tenant, actorId: f.s.human, requestId: "t26-det" };
    const first = await withTenant(db.rw, ctx, async (tx) => {
      const draft = await createTaxReturn(tx, ctx, {
        companyId: f.s.company,
        regimeId: f.regimeId,
        periodStart: "2026-01-01",
        periodEnd: "2026-03-31",
      });
      const { row } = await generateTaxReturn(tx, ctx, draft.id);
      return { id: draft.id, sha: row.payloadSha256!, by: row.generatedBy! };
    });
    expect(first.sha).toBe("df0b4de2ec7fc20f1f1fb045447792279cdbc12d2fa7ae7446d0034ee6cdc438");

    // Regenerate: same bytes, and `generated_by` keeps the FIRST generator (T8's NULL -> value rule).
    const second = await withTenant(db.rw, ctx, async (tx) => {
      const { row } = await generateTaxReturn(tx, ctx, first.id);
      return { sha: row.payloadSha256!, by: row.generatedBy! };
    });
    expect(second.sha).toBe(first.sha);
    expect(second.by).toBe(first.by);

    // A document in Q2 changes nothing about Q1. LEGACY-059's failure was the opposite: a truncated query
    // lost its period filter and the return reported every voucher ever posted.
    await postTaxedDocument(db, f, {
      typeCode: "SALES_INVOICE",
      effectiveDate: "2026-04-05",
      taxInclusive: false,
      lines: [
        { lineNo: 1, accountId: f.accounts["4000"]!, amount: "9999.0000", taxCode: "SYN-OUT-STD" },
      ],
    });
    const third = await withTenant(db.rw, ctx, (tx) => generateTaxReturn(tx, ctx, first.id));
    expect(third.row.payloadSha256).toBe(first.sha);
  }, 180_000);

  // ── Clause 2: "a tax code from the wrong regime causes a refusal, not a wrong number" ───────────────
  it("a document whose lines span two regimes is refused, and so is a return on a regime the pack lacks", async () => {
    const f = await taxFixture(db, "t26-wrong-regime");
    const ctx = { tenantId: f.s.tenant, actorId: f.s.human, requestId: "t26-wrong" };

    // A SECOND regime. `seedTaxCode` REUSES SYNTH-MY-v1 when no `regimeId` is passed (T1 Step 5), so the
    // regime row is inserted here and handed to the helper — one helper, no second spelling (hazard 9).
    const [other] = await withTenant(
      db.rw,
      ctx,
      (tx) => tx<{ id: string }[]>`
        insert into app.tax_regime (tenant_id, company_id, code, jurisdiction, version, effective_from,
                                    name_en, source)
        values (${f.s.tenant}, ${f.s.company}, 'OTHER-MY-v1', 'MY', 1, '2026-01-01',
                'Second synthetic regime', 'SYNTHETIC-TEST-v1 — not a published figure (OD-15)')
        returning id`,
    );
    const foreign = await seedTaxCode(db, f.s, {
      code: "OTHER-OUT",
      rate: "0.07000000",
      kind: "output",
      regimeId: other!.id,
    });
    // `seedTaxCode` resolves `2300` for an `output` code by itself (T1 Step 5), and `taxFixture` seeded
    // that account — so no account fix-up is needed here, and adding one would make this pass for the
    // wrong reason: the refusal below must come from the REGIME, never from a null account.
    const f2: TaxFixture = { ...f, codes: { ...f.codes, "OTHER-OUT": foreign.taxCodeId } };

    // ── Clause 2 proper: a tax code from the wrong regime, on a real document. `resolveRegimeFor`
    // refuses a document whose lines span two regimes (T7), reaching the caller through
    // `computeDocumentTax` — "a refusal, not a wrong number" (spec:2444). If this document posted, its
    // two codes' figures would land in one return with two rates and nothing to say which was which,
    // which is LEGACY-020's enum collision in its modern form.
    await expect(
      postTaxedDocument(db, f2, {
        typeCode: "SALES_INVOICE",
        effectiveDate: "2026-01-20",
        taxInclusive: false,
        lines: [
          { lineNo: 1, accountId: f.accounts["4000"]!, amount: "400.0000", taxCode: "SYN-OUT-STD" },
          { lineNo: 2, accountId: f.accounts["4000"]!, amount: "400.0000", taxCode: "OTHER-OUT" },
        ],
      }),
    ).rejects.toMatchObject({ code: "ERR_TAX_REGIME_MISMATCH" });

    // And nothing was written: the refusal happens inside the caller's transaction, before any post.
    const written = await withTenant(
      db.rw,
      ctx,
      (tx) => tx<{ n: number }[]>`
        select count(*)::int as n from app.tax_transaction where company_id = ${f.s.company}`,
    );
    expect(written[0]!.n).toBe(0);

    // ── The other half of one code: a return whose OWN regime the pack has no definition for. A regime
    // the pack does not know IS a mismatch (amendment A3) — never an empty return, which would file.
    const unknown = await withTenant(db.rw, ctx, async (tx) => {
      const draft = await createTaxReturn(tx, ctx, {
        companyId: f.s.company,
        regimeId: other!.id,
        periodStart: "2026-01-01",
        periodEnd: "2026-03-31",
      });
      return draft.id;
    });
    await expect(
      withTenant(db.rw, ctx, (tx) => generateTaxReturn(tx, ctx, unknown)),
    ).rejects.toMatchObject({ code: "ERR_TAX_REGIME_MISMATCH" });
    await expect(
      withTenant(db.rw, ctx, (tx) => generateTaxReturn(tx, ctx, unknown)),
    ).rejects.toThrow(/this pack has no definition for OTHER-MY-v1 v1/);

    // Each of the two codes posts fine on its OWN document — the refusal is about MIXING, not about the
    // second regime existing. Without this the test would pass on any breakage of `OTHER-OUT`.
    await postTaxedDocument(db, f2, {
      typeCode: "SALES_INVOICE",
      effectiveDate: "2026-01-21",
      taxInclusive: false,
      lines: [
        { lineNo: 1, accountId: f.accounts["4000"]!, amount: "400.0000", taxCode: "OTHER-OUT" },
      ],
    });
    const after = await withTenant(
      db.rw,
      ctx,
      (tx) => tx<{ tax: string }[]>`
        select tax::text from app.tax_transaction where company_id = ${f.s.company}`,
    );
    expect(after.map((r) => r.tax)).toEqual(["28.0000"]); // 400.0000 x 0.07
  }, 180_000);

  it("the pack refuses a transaction whose regime is not the return's, naming the document and line", () => {
    // Pure, and it is the second half of clause 2: the guard that stops a foreign row being silently
    // dropped (LEGACY-058's contradictory union half, in reverse). No database needed.
    const regime = {
      id: "11111111-1111-7111-8111-111111111111",
      code: "SYNTH-MY-v1",
      jurisdiction: "MY" as const,
      version: 1,
      effectiveFrom: "2026-01-01",
      effectiveTo: null,
    };
    const ccy = currency("MYR");
    const foreign = {
      documentId: "22222222-2222-7222-8222-222222222222",
      documentTypeCode: "SALES_INVOICE",
      lineNo: 1,
      taxCodeId: "33333333-3333-7333-8333-333333333333",
      taxCode: "OTHER-OUT",
      regimeId: "44444444-4444-7444-8444-444444444444",
      kind: "output" as const,
      rate: "0.07000000",
      base: Money.of("100.0000", ccy),
      tax: Money.of("7.0000", ccy),
      baseBase: Money.of("100.0000", ccy),
      taxBase: Money.of("7.0000", ccy),
      effectiveDate: "2026-01-20",
      postingSeq: "1",
    };
    expect(() =>
      malaysiaPack.buildReturn({
        regime,
        periodStart: "2026-01-01",
        periodEnd: "2026-03-31",
        transactions: [foreign],
      }),
    ).toThrow(/document 22222222-2222-7222-8222-222222222222 line 1 carries regime 44444444/);
  });

  // ── Clause 3: "validated" and "reconciled" — the DoD's other two verbs ──────────────────────────────
  it("the generated payload re-validates against the pack and both control accounts tie out", async () => {
    const input = readCase("synth-my-inclusive");
    const f = await taxFixture(db, "t26-tieout");
    for (const d of input.documents) {
      await postTaxedDocument(db, f, {
        typeCode: d.typeCode,
        effectiveDate: d.effectiveDate,
        partyId: d.party === "customer" ? f.customerId : f.vendorId,
        taxInclusive: d.taxInclusive,
        lines: d.lines.map((l) => ({
          lineNo: l.lineNo,
          kind: "account" as const,
          accountId: f.accounts[l.accountCode]!,
          amount: l.amount,
          taxCode: l.taxCode,
        })),
      });
    }
    const ctx = { tenantId: f.s.tenant, actorId: f.s.human, requestId: "t26-tie" };
    const { boxes, tie, payload } = await withTenant(db.rw, ctx, async (tx) => {
      const draft = await createTaxReturn(tx, ctx, {
        companyId: f.s.company,
        regimeId: f.regimeId,
        periodStart: "2026-01-01",
        periodEnd: "2026-03-31",
      });
      const g = await generateTaxReturn(tx, ctx, draft.id);
      return { boxes: g.boxes, payload: g.row.payload!, tie: await taxReturnTieOut(tx, draft.id) };
    });

    expect(malaysiaPack.validateReturn(payload)).toEqual({ ok: true, errors: [] });
    expect(payload).toBe(canonicalJson(JSON.parse(payload))); // the payload IS canonical, not merely valid
    expect(boxes.map((b) => [b.code, b.amount.toString()])).toEqual([
      ["S1", "800.0000"],
      ["S2", "88.0000"],
      ["S3", "450.0000"],
      ["P1", "500.0000"],
      ["P2", "55.0000"],
    ]);
    // Every box the definition declares is present, in definition order — a box the pack knows and the
    // return omits is LEGACY-011's "filed with tax but no base" in its other direction.
    expect(boxes.map((b) => b.code)).toEqual(SYNTH_MY_V1.boxes.map((b) => b.code));
    expect(tie).toEqual([
      {
        accountCode: "1350",
        boxCodes: ["P2"],
        boxBase: "55.0000",
        ledgerBase: "55.0000",
        difference: "0.0000",
      },
      {
        accountCode: "2300",
        boxCodes: ["S2"],
        boxBase: "88.0000",
        ledgerBase: "88.0000",
        difference: "0.0000",
      },
    ]);
  }, 180_000);

  it("an empty period generates a return of zero boxes and ties out to 0.0000, never to null", async () => {
    // LEGACY-011 at this boundary: `taxReturnTieOut`'s `coalesce(..., 0)` is what makes the assertion real
    // rather than vacuous. A null difference compares equal to nothing and passes no test.
    const f = await taxFixture(db, "t26-empty");
    const ctx = { tenantId: f.s.tenant, actorId: f.s.human, requestId: "t26-empty" };
    const { boxes, tie } = await withTenant(db.rw, ctx, async (tx) => {
      const draft = await createTaxReturn(tx, ctx, {
        companyId: f.s.company,
        regimeId: f.regimeId,
        periodStart: "2026-01-01",
        periodEnd: "2026-03-31",
      });
      const g = await generateTaxReturn(tx, ctx, draft.id);
      return { boxes: g.boxes, tie: await taxReturnTieOut(tx, draft.id) };
    });
    expect(boxes.map((b) => b.amount.toString())).toEqual([
      "0.0000",
      "0.0000",
      "0.0000",
      "0.0000",
      "0.0000",
    ]);
    expect(tie.map((r) => r.difference)).toEqual(["0.0000", "0.0000"]);
    expect(tie.every((r) => r.ledgerBase === "0.0000")).toBe(true);
  }, 180_000);

  it("a draft return has no boxes and refuses a tie-out", async () => {
    const f = await taxFixture(db, "t26-draft");
    const ctx = { tenantId: f.s.tenant, actorId: f.s.human, requestId: "t26-draft" };
    await withTenant(db.rw, ctx, async (tx) => {
      const draft = await createTaxReturn(tx, ctx, {
        companyId: f.s.company,
        regimeId: f.regimeId,
        periodStart: "2026-01-01",
        periodEnd: "2026-03-31",
      });
      expect((await getTaxReturn(tx, draft.id)).boxes).toEqual([]);
      await expect(taxReturnTieOut(tx, draft.id)).rejects.toMatchObject({
        code: "ERR_DOC_STATUS_ILLEGAL",
      });
    });
  }, 180_000);
});
