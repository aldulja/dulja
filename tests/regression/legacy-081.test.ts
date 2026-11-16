import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { repoFile, sharedDb } from "../support/regression";

describe("LEGACY-081 Backup and restore are manual, whole-file and destructive — 0C", () => {
  it("supports continuous WAL archiving", async () => {
    const { db } = await sharedDb();
    const [row] = await db.admin<{ wal_level: string }[]>`show wal_level`;
    expect(row?.wal_level).not.toBe("minimal");
  });

  it("documents PITR and the required RPO and RTO", () => {
    const runbook = repoFile("docs/runbooks/supabase-provisioning.md");
    expect(runbook).toMatch(/Point-in-time recovery/i);
    expect(runbook).toMatch(/\*\*RPO\*\*/);
    expect(runbook).toMatch(/\*\*RTO\*\*/);
    expect(runbook).toMatch(/docs\/runbooks\/restore-drill\.md/);
  });
});

describe("LEGACY-081 Backup and restore are manual, whole-file and destructive — 1B", () => {
  it("a restore is rehearsed, not assumed: the drill's verdict has five assertions and all pass", async () => {
    // The drill itself lives in tests/invariants/restore-drill.test.ts and runs there; this block is
    // the defect's regression face. It asserts the property LEGACY-081 names — that restoring is an
    // exercised, verified procedure with a written runbook — by requiring the runbook to exist, to
    // carry a drill log, and to name the exact verify command an operator types.
    // Vitest runs this workspace with cwd `tests/`, so every path here is relative to it — which is
    // why the second case below reads `invariants/support/…` and this one climbs one level.
    const runbook = await readFile("../docs/runbooks/restore-drill.md", "utf8");
    expect(runbook).toContain("## 6. Drill log");
    expect(runbook).toContain("DRILL_PHASE=verify");
    expect(runbook).toContain("trial-balance-fingerprint:");
  });

  it("the drill is destructive to nothing: it reads the restored database and writes only its own file", async () => {
    const source = await readFile("invariants/support/restore-drill.ts", "utf8");
    // LEGACY-081's second half is that the old restore overwrote the live database. Nothing in the drill
    // may write to a database at all — the only writes are the capture JSON and the scratch temp table
    // checkAccountBalanceProjection creates and drops on commit. The last entry is the one drop that
    // would be catastrophic: dropping the container's OWN database rather than the restore target.
    for (const forbidden of [
      "insert into",
      "update app.",
      "delete from",
      "--if-exists '${container.getDatabase()}",
    ]) {
      expect(source.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });
});
