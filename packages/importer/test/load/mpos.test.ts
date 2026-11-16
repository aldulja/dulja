import { describe, expect, it } from "vitest";
// The registry FIRST: a loader module imports `./run`, which imports the registry, so importing a loader module first
// would build `loaders` with that loader's own binding unset (9B T6's note).
import { loaders } from "../../src/load/registry";
import { MPOS_SOURCE_TABLES, mposLoader } from "../../src/load/mpos";
import { withRunScope } from "../../src/load/run";
import { currency, Money } from "@dulja/domain";
import { FixtureLegacyDriver } from "../../src/drivers/fixture";
import type { LegacyRow } from "../../src/legacy/types";
import { preflight } from "../../src/load/preflight";
import type { Loader } from "../../src/load/types";
import { createReader } from "../../src/reader";
import { loadCorpus } from "../support/corpus";

const MYR = currency("MYR");
const nothing = { byLegacyRef: async () => null };
/** `map` mints `Money` in the run's base currency (`baseCurrency()`), which only a run scope sets. */
const mapped = (row: LegacyRow) =>
  withRunScope({ baseCurrency: MYR, cutOverDate: "2026-01-31" }, async () =>
    mposLoader.map(row, nothing),
  );

describe("the historical POS loader (OD-16 ⚠️ — default: start clean; 9B T13)", () => {
  it("is NOT registered: with OD-16 unanswered no run touches mpos (§2.12 default)", () => {
    expect(loaders.map((l) => l.targetTable)).not.toContain("pos_ticket");
    expect(loaders).not.toContain(mposLoader);
    expect(loaders.map((l) => l.sourceTable).filter((t) => MPOS_SOURCE_TABLES.includes(t))).toEqual(
      [],
    );
    expect(
      loaders.flatMap((l) => l.sourceColumns.map((c) => c.name)).filter((n) => n.startsWith("PTK")),
    ).toEqual([]);
  });

  it("declares the two mpos tables and passes pre-flight against the mpos-history corpus", async () => {
    expect(MPOS_SOURCE_TABLES).toEqual(["POSTICKETS", "POSENTRIES"]);
    expect(mposLoader.sourceTable).toBe("POSTICKETS");
    expect(mposLoader.targetTable).toBe("pos_ticket");
    for (const column of mposLoader.sourceColumns) expect(column.confidence).toBe("hypothesis");
    const driver = new FixtureLegacyDriver(loadCorpus("mpos-history"));
    const report = await preflight(driver, [mposLoader as unknown as Loader<unknown, unknown>]);
    expect(report).toEqual({ ok: true, findings: [], checkedTables: ["POSTICKETS"] });
  });

  it("maps a historical ticket into the 6A TicketBatch shape, keeping its own sale date", async () => {
    const reader = await createReader(new FixtureLegacyDriver(loadCorpus("mpos-history")));
    const rows: LegacyRow[] = [];
    for await (const page of reader.read<LegacyRow>("POSTICKETS", {
      columns: mposLoader.sourceColumns.map((c) => c.name),
      batch: 10,
    }))
      rows.push(...page);
    // One at a time: a run scope is one per process.
    const first = await mapped(rows[0]!);
    const second = await mapped(rows[1]!);
    expect(rows).toHaveLength(2);
    expect(first).toMatchObject({
      legacyKey: "9100",
      ticketNumber: "T-000431",
      terminalCode: "TILL-1",
      cashierRef: "5001",
      soldAt: "2025-12-30",
      lines: [],
    });
    const tender = (first as { tenders: { method: string; amount: Money }[] }).tenders;
    expect(tender.map((t) => [t.method, t.amount.toString()])).toEqual([["cash", "45.0000"]]);
    expect(second).toEqual({
      skip: 'ticket T-000432 has tender method "voucher", which is not one of the four §4.6.5 methods',
    });
  });

  it("reports a ticket whose terminal was never named, rather than inventing one", async () => {
    expect(
      await mapped({
        PTKID: "2",
        PTKNUMBER: "T-0002",
        PTKDATE: "2025-12-30",
        PTKTERMINAL: "",
        PTKCASHIER: null,
        PTKTOTAL: "10.0000",
        PTKTENDER: "cash",
      }),
    ).toEqual({
      skip: "ticket T-0002 names no terminal; a POS_TICKET must be attributed to an enrolled terminal (spec:1324)",
    });
  });

  it("refuses to load, naming what a yes would take — it never writes a ticket while OD-16 is open", async () => {
    await expect(
      mposLoader.load(
        undefined as never,
        undefined as never,
        [] as Parameters<typeof mposLoader.load>[2],
      ),
    ).rejects.toThrow(
      // A string, not a regex literal: `dependency-rule`'s token scanner stalls on a `#` inside one (9B T6's note).
      "ERR_VALIDATION_FAILED: the historical POS loader is not enabled: OD-16 (Part VII #10) has not been answered",
    );
  });
});
