import { describe, expect, it } from "vitest";
import { FixtureLegacyDriver } from "../src/drivers/fixture";
import { isMposTable, mposDecision, MPOS_MODULE_IDS } from "../src/mpos";
import { profile } from "../src/profile";
import { createReader } from "../src/reader";
import { loadCorpus } from "./support/corpus";

const names = (report: { tables: { name: string }[] }): string[] =>
  report.tables.map((t) => t.name);

describe("OD-16 — whether the mpos schema is read at all (Part VII #10)", () => {
  it("names the two POS databases and nothing else", () => {
    expect([...MPOS_MODULE_IDS]).toEqual(["mposstandard", "mpossystem"]);
    expect(isMposTable("POSTICKETS")).toBe(true);
    expect(isMposTable("POSENTRYITEMS")).toBe(true);
    expect(isMposTable("VOUITEMS")).toBe(false);
    // A `pos`-prefixed name that is not in the shipped map is NOT assumed to be POS: the map decides.
    expect(isMposTable("POSSIBLE_CUSTOM_TABLE")).toBe(false);
  });

  it("profile excludes POS tables from the main database unless asked", async () => {
    const merged = {
      ...loadCorpus(),
      tables: { ...loadCorpus().tables, ...loadCorpus("mpos").tables },
    };
    const reader = await createReader(new FixtureLegacyDriver(merged));
    const without = await profile(reader);
    const withMpos = await profile(reader, { includeMpos: true });
    // The claim is the filter, not the corpus (plan 9A correction C1, applied where the test is first written):
    // no POS table survives the default, both survive the switch, and the switch adds nothing else.
    expect(names(without).filter(isMposTable)).toEqual([]);
    expect(names(withMpos).filter(isMposTable)).toEqual(["POSENTRIES", "POSTICKETS"]);
    expect(names(withMpos).filter((name) => !isMposTable(name))).toEqual(names(without));
    // "Not read" is answered honestly: the POS modules are not in use as far as the default profile knows.
    expect(without.modulesInUse.mposstandard).toBe(false);
    expect(without.modulesInUse.mpossystem).toBe(false);
    expect(withMpos.modulesInUse.mposstandard).toBe(true);
  });

  it("produces the decision input and no verdict", async () => {
    const report = await mposDecision(
      await createReader(new FixtureLegacyDriver(loadCorpus("mpos"))),
    );
    expect(report.present).toBe(true);
    expect(report.ticketRows).toBe(2);
    expect(report.ticketDateRange).toEqual({
      min: "2023-11-04 08:15:00.0000",
      max: "2024-05-20 19:02:11.0000",
    });
    expect(report.tables).toEqual([
      {
        table: "POSENTRIES",
        rows: 1,
        dateRange: { min: "2023-11-04 08:15:00.0000", max: "2023-11-04 08:15:00.0000" },
      },
      {
        table: "POSTICKETS",
        rows: 2,
        dateRange: { min: "2023-11-04 08:15:00.0000", max: "2024-05-20 19:02:11.0000" },
      },
    ]);
    expect(report.answer).toBeNull();
    expect(report.question).toContain("Must historical POS");
    expect(report.question).toContain("OD-16");
  });

  it("says so plainly when there is no POS data at all", async () => {
    const report = await mposDecision(await createReader(new FixtureLegacyDriver(loadCorpus())));
    expect(report.present).toBe(false);
    expect(report.ticketRows).toBe(0);
    expect(report.ticketDateRange).toBeNull();
    expect(report.tables).toEqual([]);
  });
});
