import { randomUUID } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Sql } from "postgres";
import {
  agedBalance,
  ageingTieOut,
  draftSettlement,
  openBalance,
  partyBalance,
  withTenant,
} from "@dulja/db";
import { seedAccount, seedDocumentType, startDb, type Db, type Seed } from "@dulja/db/test";
import { currency, Money } from "@dulja/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FixtureLegacyDriver, type LegacyCorpus } from "../../src/drivers/fixture";
import type { LegacyRow } from "../../src/legacy/types";
import { createReader } from "../../src/reader";
import { readAccountMap } from "../../src/load/account-map";
import { clearAccountMap, setAccountMap } from "../../src/load/accounts";
// The registry BEFORE the loader module (9B T6's note): a loader imports `./run` and `./refs`, which import the
// registry, so a test that entered the cycle through `open-items` itself would build `loaders` with this one unset.
import { loaders } from "../../src/load/registry";
import { openItemLoader } from "../../src/load/open-items";
import { draftAndPost } from "../../src/load/document";
import { runLoad, setLoadSource, withRunScope } from "../../src/load/run";
import { clearKeyRing, setKeyRing } from "../../src/load/employees";
import type { LoadContext, LoadReport } from "../../src/load/types";
import { loadCorpus } from "../support/corpus";
import { loadContextFor, seedLoadableTenant, TEST_KEY_RING } from "../support/tenant";

let db: Db;
let s: Seed;
let first: LoadReport;
const runs: string[] = [];
const MYR = currency("MYR");
const MAP = fileURLToPath(new URL("../fixtures/account-map.json", import.meta.url));
const RECEIPT_JSON = fileURLToPath(
  new URL("../../../db/seed/my/document-types/RECEIPT.json", import.meta.url),
);

function newRun(): string {
  const id = randomUUID();
  runs.push(id);
  return id;
}

function useCorpus(corpus: LegacyCorpus): void {
  setLoadSource(async () => {
    const driver = new FixtureLegacyDriver(corpus);
    return { driver, reader: await createReader(driver), close: () => driver.close() };
  });
}

/** The cut-over corpus with `BILLS` replaced. */
function withBills(rows: readonly LegacyRow[]): LegacyCorpus {
  const corpus = loadCorpus("cut-over");
  return {
    ...corpus,
    tables: { ...corpus.tables, BILLS: { ...corpus.tables["BILLS"]!, rows: [...rows] } },
  };
}

const bill = (
  id: string,
  number: string,
  account: string,
  open: string | null,
  kind: string,
  date = "2025-12-01",
): LegacyRow => ({
  BILID: id,
  BILNUMBER: number,
  BILACC: account,
  BILDATE: date,
  BILOPEN: open,
  BILKIND: kind,
});

const ctxFor = (seed: Seed, over: Partial<LoadContext> = {}): Promise<LoadContext> =>
  loadContextFor(db, seed, over.runId ?? newRun(), over);

/** Read as the tenant's system principal: `document` and `ledger_entry` are branch-isolated (§4.5.6), and the seed's
 *  human holds no role in the company. */
const read = <T>(seed: Seed, fn: (tx: Sql) => Promise<T>): Promise<T> =>
  withTenant(db.rw, { tenantId: seed.tenant, actorId: seed.system, requestId: randomUUID() }, fn);

/** `import_batch`'s natural key has no run scoping, so a case whose evidence is a different `BILLS` needs a tenant of
 *  its own (T5's reasoning). */
const ownTenant = (name: string): Promise<Seed> =>
  seedLoadableTenant(db, `${name}-${randomUUID().slice(0, 8)}`);

interface OpenDoc {
  id: string;
  legacy_ref: string;
  series: string;
  number: string;
  status: string;
  effective_date: string;
  party: string;
  branch: string;
  created_by_system: boolean;
}

const openItems = (seed: Seed): Promise<OpenDoc[]> =>
  read(
    seed,
    (tx) => tx<OpenDoc[]>`
      select d.id::text as id, d.legacy_ref, d.series, d.number::text as number, d.status::text as status,
             to_char(d.effective_date, 'YYYY-MM-DD') as effective_date, p.code as party, v.code as branch,
             d.created_by = ${seed.system} as created_by_system
        from app.document d
        join app.document_type t on t.id = d.document_type_id
        join app.party p on p.id = d.party_id
        join app.dimension_value v on v.id = d.branch_id
       where d.company_id = ${seed.company} and t.code = 'OPENING_BALANCE' and d.legacy_ref is not null
       order by d.number::bigint`,
  );

const ledgerOf = (seed: Seed, partyKind: "customer" | "vendor") =>
  read(
    seed,
    (tx) => tx<{ code: string; debit: string; credit: string }[]>`
      select a.code, l.base_debit::text as debit, l.base_credit::text as credit
        from app.ledger_entry l
        join app.account a on a.id = l.account_id
        join app.document d on d.id = l.document_id
        join app.party p on p.id = d.party_id
       where d.company_id = ${seed.company} and d.legacy_ref is not null and p.kind = ${partyKind}
       order by a.code`,
  );

const aged = (seed: Seed, partyKind: "customer" | "vendor", asOf = "2026-01-31") =>
  read(seed, (tx) => agedBalance(tx, { companyId: seed.company, asOf, partyKind, limit: 100 }));

/** §4.8.2's tie-out is "to the cent", so the sum is `Money`, never `Number(...)`. */
const totalOf = (rows: readonly { total: string }[]): string =>
  rows.reduce((m, r) => m.add(Money.of(r.total, MYR)), Money.zero(MYR)).toString();

beforeAll(async () => {
  db = await startDb();
  s = await seedLoadableTenant(db, "open-items");
  setAccountMap(readAccountMap(MAP));
  setKeyRing(TEST_KEY_RING);
  useCorpus(loadCorpus("cut-over"));
  first = await runLoad(db.rw, await ctxFor(s));
}, 300_000);

afterAll(async () => {
  clearAccountMap();
  clearKeyRing();
  for (const id of runs) rmSync(join("artefacts", "legacy", id), { recursive: true, force: true });
  await db?.stop();
});

describe("open AR/AP items at cut-over (§5.1 #8; ADR 0085)", () => {
  it("is a paged loader over BILLS that resolves parties only", () => {
    expect(openItemLoader.targetTable).toBe("open_item");
    expect(openItemLoader.sourceTable).toBe("BILLS");
    expect(openItemLoader.wholeTable).toBeUndefined();
    expect(openItemLoader.dependsOn).toEqual(["party"]);
    expect(openItemLoader.sourceColumns.map((c) => c.name)).toEqual([
      "BILID",
      "BILNUMBER",
      "BILACC",
      "BILDATE",
      "BILOPEN",
      "BILKIND",
    ]);
    for (const column of openItemLoader.sourceColumns) {
      expect(column.confidence).toBe("hypothesis");
      expect(column.required).toBe(true);
    }
    expect(loaders.map((l) => l.targetTable)).toContain("open_item");
  });

  it("posts one OPENING_BALANCE per open legacy document, carrying its number as a string", async () => {
    // Ordered by `number`, NOT by `legacy_ref`: the two corpus rows deliberately SHARE 'INV/2025/0417' — SAH-051's own
    // fact — so `document.number`, the posting service's gapless bigint, is the deterministic key. OB 1 is the trial
    // balance's opening (Task 5), which runs first.
    const docs = await openItems(s);
    expect(docs.map(({ id: _id, ...rest }) => rest)).toEqual([
      {
        legacy_ref: "INV/2025/0417",
        series: "OB",
        number: "2",
        status: "posted",
        effective_date: "2026-01-31",
        party: "C-2001",
        branch: "HQ",
        created_by_system: true,
      },
      {
        legacy_ref: "INV/2025/0417",
        series: "OB",
        number: "3",
        status: "posted",
        effective_date: "2026-01-31",
        party: "V-3001",
        branch: "HQ",
        created_by_system: true,
      },
    ]);
    expect(first.perLoader["open_item"]).toEqual({ inserted: 2, skipped: 0, conflicts: 0 });
    expect(first.skips.filter((k) => k.loader === "open_item")).toEqual([]);
  });

  it("records each BILID against its own document", async () => {
    const docs = await openItems(s);
    const batches = await read(
      s,
      (tx) => tx<{ source_key: string; target_table: string; target_id: string }[]>`
        select source_key, target_table, target_id::text as target_id from app.import_batch
         where company_id = ${s.company} and source_table = 'BILLS' order by source_key`,
    );
    expect(batches).toEqual([
      { source_key: "5001", target_table: "open_item", target_id: docs[0]!.id },
      { source_key: "6001", target_table: "open_item", target_id: docs[1]!.id },
    ]);
  });

  it("posts the AR side as Dr 1200 / Cr 3900 and the AP side as Dr 3900 / Cr 2100", async () => {
    expect(await ledgerOf(s, "customer")).toEqual([
      { code: "1200", debit: "1800.0000", credit: "0.0000" },
      { code: "3900", debit: "0.0000", credit: "1800.0000" },
    ]);
    expect(await ledgerOf(s, "vendor")).toEqual([
      { code: "2100", debit: "0.0000", credit: "900.0000" },
      { code: "3900", debit: "900.0000", credit: "0.0000" },
    ]);
  });

  it("never re-recognises revenue or expense and invents no tax (ADR 0085; Phase 5)", async () => {
    const touched = await read(
      s,
      (tx) => tx<{ type: string; n: number }[]>`
        select a.type::text as type, count(*)::int as n
          from app.ledger_entry l join app.account a on a.id = l.account_id
          join app.document d on d.id = l.document_id
         where d.company_id = ${s.company} and d.legacy_ref is not null
         group by a.type order by a.type::text`,
    );
    expect(touched).toEqual([
      { type: "asset", n: 1 },
      { type: "equity", n: 2 },
      { type: "liability", n: 1 },
    ]);
    const taxed = await read(
      s,
      (tx) => tx<{ facts: number; coded: number }[]>`
        select (select count(*)::int from app.tax_transaction x
                  join app.document d on d.id = x.document_id
                 where d.company_id = ${s.company} and d.legacy_ref is not null) as facts,
               (select count(*)::int from app.document_line l
                  join app.document d on d.id = l.document_id
                 where d.company_id = ${s.company} and d.legacy_ref is not null
                   and l.tax_code_id is not null) as coded`,
    );
    expect(taxed).toEqual([{ facts: 0, coded: 0 }]);
  });

  it("keeps the legacy date in the control line's description and ages from the cut-over date", async () => {
    const lines = await read(
      s,
      (tx) => tx<{ description: string }[]>`
        select l.description from app.document_line l join app.document d on d.id = l.document_id
         where d.company_id = ${s.company} and d.legacy_ref is not null and l.line_no = 1
         order by d.number::bigint`,
    );
    expect(lines.map((l) => l.description)).toEqual([
      "Open receivable at cut-over — legacy INV/2025/0417 dated 2025-12-14",
      "Open payable at cut-over — legacy INV/2025/0417 dated 2025-12-20",
    ]);
    // Global constraint 3: the effective date is the cut-over date, so on that date every open item is `current`.
    const [row] = await aged(s, "customer");
    expect(row).toMatchObject({ current: "1800.0000", over_90: "0.0000", total: "1800.0000" });
  });

  it("makes Σ open items per party equal the party's balance, and the ageing tie to 1200 and 2100 to the cent (§4.8.2)", async () => {
    const customer = await aged(s, "customer");
    const vendor = await aged(s, "vendor");
    expect(customer.map((r) => [r.partyCode, r.total])).toEqual([["C-2001", "1800.0000"]]);
    expect(vendor.map((r) => [r.partyCode, r.total])).toEqual([["V-3001", "900.0000"]]);
    expect(totalOf(customer)).toBe("1800.0000");
    expect(totalOf(vendor)).toBe("900.0000");

    const balances = await read(s, async (tx) => {
      const out: string[] = [];
      for (const r of [...customer, ...vendor])
        out.push(
          (
            await partyBalance(tx, { companyId: s.company, partyId: r.partyId, asOf: "2026-01-31" })
          ).base.toString(),
        );
      return out;
    });
    expect(balances).toEqual(["1800.0000", "900.0000"]);

    const tie = await read(s, (tx) =>
      ageingTieOut(tx, { companyId: s.company, asOf: "2026-01-31" }),
    );
    expect(tie.map((r) => [r.accountCode, r.ageingBase, r.ledgerBase, r.difference])).toEqual([
      ["1200", "1800.0000", "1800.0000", "0.0000"],
      ["2100", "900.0000", "900.0000", "0.0000"],
    ]);
  });

  it("starts the new gapless series after cut-over: document_series carries only OB and OS", async () => {
    const series = await read(
      s,
      (tx) => tx<{ series: string }[]>`
        select distinct series from app.document_series where company_id = ${s.company} order by series`,
    );
    expect(series.map((x) => x.series)).toEqual(["OB", "OS"]);
  });

  it("keeps document.number a gapless bigint per series while legacy_ref carries the duplicated string", async () => {
    const numbers = await read(
      s,
      (tx) => tx<{ number: string }[]>`
        select d.number::text as number from app.document d
          join app.document_type t on t.id = d.document_type_id
         where d.company_id = ${s.company} and t.code = 'OPENING_BALANCE' order by d.number::bigint`,
    );
    expect(numbers.map((n) => n.number)).toEqual(["1", "2", "3"]);
  });

  it("re-running the load posts no second open item", async () => {
    const again = await runLoad(db.rw, await ctxFor(s));
    expect(again.perLoader["open_item"]).toEqual({ inserted: 0, skipped: 2, conflicts: 0 });
    expect(await openItems(s)).toHaveLength(2);
  });

  it("skips an open item whose party never imported (§5.1 #3, SAH-073)", async () => {
    useCorpus(withBills([bill("77", "INV/2025/0999", "888", "500.0000", "1")]));
    try {
      const report = await runLoad(db.rw, await ctxFor(s));
      expect(report.skips.filter((k) => k.loader === "open_item")).toEqual([
        {
          loader: "open_item",
          sourceTable: "BILLS",
          sourceKey: "77",
          reason:
            "account 888 has no imported party; the open item INV/2025/0999 is an orphan (SAH-073)",
        },
      ]);
      expect(await openItems(s)).toHaveLength(2);
    } finally {
      useCorpus(loadCorpus("cut-over"));
    }
  });

  it("posts a legacy credit (a negative open amount) on the OTHER side, and reports a settled one", async () => {
    const own = await ownTenant("open-credit");
    useCorpus(
      withBills([
        bill("7001", "CN/2025/0012", "200", "-250.0000", "1"),
        bill("7002", "INV/2025/0100", "200", "0.0000", "1"),
        bill("7003", "DN/2025/0003", "300", "-40.0000", "2"),
      ]),
    );
    try {
      const report = await runLoad(db.rw, await ctxFor(own));
      expect(report.skips.filter((k) => k.loader === "open_item")).toEqual([
        {
          loader: "open_item",
          sourceTable: "BILLS",
          sourceKey: "7002",
          reason:
            "open item INV/2025/0100 has a zero open amount; a settled document is history, not an opening",
        },
      ]);
      expect(await ledgerOf(own, "customer")).toEqual([
        { code: "1200", debit: "0.0000", credit: "250.0000" },
        { code: "3900", debit: "250.0000", credit: "0.0000" },
      ]);
      expect(await ledgerOf(own, "vendor")).toEqual([
        { code: "2100", debit: "40.0000", credit: "0.0000" },
        { code: "3900", debit: "0.0000", credit: "40.0000" },
      ]);
      expect(totalOf(await aged(own, "customer"))).toBe("-250.0000");
      expect(totalOf(await aged(own, "vendor"))).toBe("-40.0000");
      const tie = await read(own, (tx) =>
        ageingTieOut(tx, { companyId: own.company, asOf: "2026-01-31" }),
      );
      expect(tie.map((r) => r.difference)).toEqual(["0.0000", "0.0000"]);
    } finally {
      useCorpus(loadCorpus("cut-over"));
    }
  });

  it("refuses an open item its party would not age, rather than posting it outside the tie-out", async () => {
    // A receivable of a VENDOR: V-3001's open items age on 2100 (`app.party_control_account`), so a debit on 1200 would
    // sit in no party's ageing and break §4.8.2's tie-out. The page rolls back whole.
    const own = await ownTenant("open-mismatch");
    useCorpus(withBills([bill("7101", "INV/2025/0500", "300", "120.0000", "1")]));
    try {
      await expect(runLoad(db.rw, await ctxFor(own))).rejects.toThrow(
        "ERR_VALIDATION_FAILED: legacy open item INV/2025/0500 is a receivable of vendor V-3001, whose open items age on 2100 (app.party_control_account), not on the ar_control 1200; correct the party or the legacy kind before the load (contracts §4.8.2)",
      );
      expect(await openItems(own)).toEqual([]);
    } finally {
      useCorpus(loadCorpus("cut-over"));
    }
  });

  it("refuses a legacy kind it cannot read, a NULL open amount (SAH-007) and a document after the cut-over date", async () => {
    const own = await ownTenant("open-bad");
    useCorpus(withBills([bill("7201", "INV/2025/0600", "200", "10.0000", "3")]));
    try {
      await expect(runLoad(db.rw, await ctxFor(own))).rejects.toThrow(
        "ERR_VALIDATION_FAILED: BILLS/7201: BILKIND is 3; an open item is 1 (receivable) or 2 (payable)",
      );
      useCorpus(withBills([bill("7202", "INV/2025/0601", "200", null, "1")]));
      await expect(runLoad(db.rw, await ctxFor(own))).rejects.toThrow(/BILLS\/7202.*BILOPEN/);
      // An open item is the position ON the cut-over date: a later legacy document means the source was not frozen.
      useCorpus(withBills([bill("7203", "INV/2026/0001", "200", "10.0000", "1", "2026-02-02")]));
      await expect(runLoad(db.rw, await ctxFor(own))).rejects.toThrow(
        "ERR_VALIDATION_FAILED: legacy open item INV/2026/0001 is dated 2026-02-02, after the cut-over date 2026-01-31; freeze the source on the cut-over date, or correct the date",
      );
      expect(await openItems(own)).toEqual([]);
    } finally {
      useCorpus(loadCorpus("cut-over"));
    }
  });

  it("refuses to open items or the trial balance in a company that already posted a document the import did not create (9B review, finding 4)", async () => {
    // A company already trading: one JOURNAL posted by hand. An opening posted on top of it would double its
    // balances, and a principal holding the import gate must not be able to add openings to a live company's books.
    const own = await ownTenant("open-live");
    const ctx = await ctxFor(own);
    const ids = await read(
      own,
      (tx) =>
        tx<{ cash: string; sales: string }[]>`
        select (select id::text from app.account where company_id = ${own.company} and code = '1000') as cash,
               (select id::text from app.account where company_id = ${own.company} and code = '4000') as sales`,
    );
    const ten = Money.of("10.0000", MYR);
    const zero = Money.zero(MYR);
    const posted = await withRunScope({ baseCurrency: MYR, cutOverDate: "2026-01-31" }, () =>
      withTenant(db.rw, ctx, (tx) =>
        draftAndPost(tx, ctx, {
          documentTypeCode: "JOURNAL" as "OPENING_BALANCE",
          legacyRef: null,
          lines: [
            {
              lineNo: 1,
              kind: "account",
              accountId: ids[0]!.cash,
              description: "sale",
              debit: ten,
              credit: zero,
            },
            {
              lineNo: 2,
              kind: "account",
              accountId: ids[0]!.sales,
              description: "sale",
              debit: zero,
              credit: ten,
            },
          ],
        }),
      ),
    );
    expect(posted.series).toBe("JV");
    await expect(
      runLoad(db.rw, await ctxFor(own, { only: ["account", "party", "open_item"] })),
    ).rejects.toThrow(
      /^ERR_VALIDATION_FAILED: company .* already holds JOURNAL JV 1, posted outside the cut-over load; open items are an opening/,
    );
    expect(await openItems(own)).toEqual([]);
    await expect(runLoad(db.rw, await ctxFor(own, { only: ["opening_balance"] }))).rejects.toThrow(
      /already holds JOURNAL JV 1, posted outside the cut-over load; the trial-balance opening is an opening/,
    );
  });

  it("is settled by an ordinary receipt on day one: allocation, ageing and tie-out all read the opening (§4.8.1)", async () => {
    const own = await ownTenant("open-settle");
    await seedAccount(db, own, { code: "1100", nameEn: "Bank", type: "asset" });
    const envelope = JSON.parse(readFileSync(RECEIPT_JSON, "utf8")) as {
      code: string;
      module: "accounting";
      policyVersion: number;
      effectiveFrom: string;
      policy: unknown;
    };
    const receiptType = await seedDocumentType(db, own, {
      code: envelope.code,
      module: envelope.module,
      policy: envelope.policy,
      policyVersion: envelope.policyVersion,
      effectiveFrom: envelope.effectiveFrom,
    });
    const ctx = await ctxFor(own);
    await runLoad(db.rw, ctx);
    const [receivable] = (await openItems(own)).filter((d) => d.party === "C-2001");

    const open = await withTenant(db.rw, ctx, async (tx) => {
      const [refs] = await tx<{ party: string; bank: string }[]>`
        select (select id::text from app.party where company_id = ${own.company} and code = 'C-2001') as party,
               (select id::text from app.account where company_id = ${own.company} and code = '1100') as bank`;
      await draftSettlement(tx, ctx, {
        companyId: own.company,
        documentTypeId: receiptType,
        series: "RCT",
        effectiveDate: "2026-01-31",
        partyId: refs!.party,
        bankAccountId: refs!.bank,
        currency: "MYR",
        exchangeRate: "1.00000000",
        amount: "1000.0000",
        allocations: [{ settledDocumentId: receivable!.id, amount: "1000.0000" }],
      });
      return openBalance(tx, { companyId: own.company, documentId: receivable!.id });
    });
    expect(open.document.toString()).toBe("800.0000");
    expect(totalOf(await aged(own, "customer"))).toBe("800.0000");
    const tie = await read(own, (tx) =>
      ageingTieOut(tx, { companyId: own.company, asOf: "2026-01-31" }),
    );
    expect(tie.map((r) => [r.accountCode, r.ledgerBase, r.difference])).toEqual([
      ["1200", "800.0000", "0.0000"],
      ["2100", "900.0000", "0.0000"],
    ]);
  });
});
