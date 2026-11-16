import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { trialBalanceFingerprint, withTenant } from "@dulja/db";
import { seedTenantV2, startDb, uuidv7, type Db, type Seed } from "@dulja/db/test";
import { postJournal } from "./support/post-journal";
import {
  captureDrillPoint,
  formatDrillVerdict,
  readCapture,
  restoreDatabase,
  snapshotDatabase,
  verifyRestore,
  writeCapture,
  type DrillCapture,
  type DrillVerdict,
} from "./support/restore-drill";

/**
 * Acceptance test 24 (spec:2442): "Restore to an arbitrary point in time; the trial balance computed
 * from the restored ledger equals the trial balance the live system reported at that timestamp, and the
 * audit chain verifies up to that point." SAH-081: backup and restore were manual, whole-file and
 * destructive, and were never rehearsed.
 *
 * Three modes, one set of assertions. `DRILL_PHASE` selects; `describe.runIf` means the modes that do
 * not apply are reported as skipped rather than passing on an early return.
 *
 *   local   (default) — the whole drill in one process against startDb(), with a pg_dump snapshot
 *                       standing in for the WAL replay. This is what CI runs.
 *   capture           — against DRILL_LIVE_URL: record what the live system reports at the target.
 *   verify            — against DRILL_RESTORED_URL: assert every recorded figure.
 *
 * capture and verify are separate processes because the restore happens between them and may take an
 * hour. They never both connect to a database, so the drill works whether the platform restores beside
 * the live database or in place of it — a property of the platform, which this file asserts nothing
 * about. ADR 0025 states what the local snapshot does and does not prove.
 */
const phase = (process.env["DRILL_PHASE"] ?? "local") as "local" | "capture" | "verify";

/** Required environment, with a message that names the phase rather than failing on `undefined`. */
function env(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(
      `${name} must be set when DRILL_PHASE=${phase} (see docs/runbooks/restore-drill.md)`,
    );
  }
  return value;
}

/**
 * The whole of test 24. Every mode calls this and no mode adds an assertion of its own — that is what
 * makes "the staging run adds no new assertion" true in code and not only in ADR 0025.
 */
function assertDrillVerdict(verdict: DrillVerdict, capture: DrillCapture): void {
  expect(verdict.fingerprintMatches).toBe(true); // the trial balance at the target
  expect(verdict.projectionMismatches).toBe(0); // …and it equals a rebuild from the restored ledger
  expect(verdict.chain.brokenLinks).toBe(0); // "the audit chain verifies up to that point"
  expect(verdict.chain.badHashes).toBe(0);
  expect(verdict.chain.headSeq).toBe(capture.auditHeadSeq);
  expect(verdict.postings).toBe(capture.postings); // no row lost, and no write raced the capture
  expect(["differs", "skipped"]).toContain(verdict.divergence);
  const lines = formatDrillVerdict(verdict).split("\n");
  expect(lines).toHaveLength(5);
  console.info(lines.join("\n")); // the five lines the runbook records
}

describe.runIf(phase === "local")(
  "restore drill — local equivalent (acceptance test 24; SAH-081)",
  () => {
    let db: Db;
    let s: Seed;
    let restored: Sql | undefined;

    beforeAll(async () => {
      db = await startDb();
      s = await seedTenantV2(db, "Drill");
    }, 180_000);
    afterAll(async () => {
      if (restored !== undefined) await restored.end();
      await db.stop();
    });

    const ctxFor = async () => ({
      tenantId: s.tenant,
      actorId: s.human,
      requestId: await uuidv7(db.admin),
    });

    it("restores to an arbitrary point in time and every recorded figure matches", async () => {
      // ── 1. Postings that exist before the recovery target ──────────────────────
      for (const amount of ["100.0000", "250.5000", "17.2500"]) {
        await postJournal(db, s, [
          { account: s.cash, debit: amount },
          { account: s.sales, credit: amount },
        ]);
      }

      // ── 2. T1: the point in time, and what the live system reported at it ──────
      const capture = await withTenant(db.rw, await ctxFor(), (tx) =>
        captureDrillPoint(tx, {
          tenantId: s.tenant,
          actorId: s.human,
          companyId: s.company,
          fiscalPeriodId: s.period,
        }),
      );
      await writeCapture(capture);
      await snapshotDatabase(db);

      // ── 3. Divergence: postings that must NOT survive the restore ──────────────
      for (const amount of ["9999.0000", "1.0001"]) {
        await postJournal(db, s, [
          { account: s.cash, debit: amount },
          { account: s.sales, credit: amount },
        ]);
      }
      const liveNow = await withTenant(db.rw, await ctxFor(), (tx) =>
        trialBalanceFingerprint(tx, { companyId: s.company, fiscalPeriodId: s.period }),
      );
      expect(liveNow).not.toBe(capture.fingerprint); // the divergence is real, not assumed

      // ── 4. Restore to T1 and verify ────────────────────────────────────────────
      const restoreStartedAt = new Date().toISOString();
      restored = postgres(await restoreDatabase(db), { max: 2, onnotice: () => {} });

      const reread = await readCapture(); // through the artifact, exactly as staging does
      const verdict = await verifyRestore(restored, {
        capture: reread,
        liveFingerprintAtRestore: liveNow,
        restoreStartedAt,
      });

      assertDrillVerdict(verdict, reread);
      expect(verdict.divergence).toBe("differs"); // locally the live database always still exists
    }, 300_000);
  },
);

describe.runIf(phase === "capture")(
  "restore drill — capture at the recovery target (test 24, 1 of 2)",
  () => {
    let live: Sql;

    beforeAll(() => {
      live = postgres(env("DRILL_LIVE_URL"), { max: 2, onnotice: () => {} });
    });
    afterAll(async () => {
      await live.end();
    });

    it("records what the live system reports at the recovery target", async () => {
      const tenantId = env("DRILL_TENANT_ID");
      const actorId = env("DRILL_ACTOR_ID");
      const ctx = { tenantId, actorId, requestId: await uuidv7(live) };

      const capture = await withTenant(live, ctx, (tx) =>
        captureDrillPoint(tx, {
          tenantId,
          actorId,
          companyId: env("DRILL_COMPANY_ID"),
          fiscalPeriodId: env("DRILL_PERIOD_ID"),
        }),
      );

      // A drill against an empty ledger proves nothing, and would pass every assertion in phase 2.
      expect(capture.postings).toBeGreaterThan(0);
      await writeCapture(capture);

      console.info(`recovery target: ${capture.capturedAt}`);
      console.info(
        `live fingerprint: ${capture.fingerprint} (${capture.postings} postings, audit head ${capture.auditHeadSeq})`,
      );
    }, 120_000);
  },
);

describe.runIf(phase === "verify")(
  "restore drill — verify the restored database (test 24, 2 of 2)",
  () => {
    let restored: Sql;
    let live: Sql | undefined;

    beforeAll(() => {
      restored = postgres(env("DRILL_RESTORED_URL"), { max: 2, onnotice: () => {} });
      // Absent for an in-place restore. Its absence is reported, never assumed either way.
      const liveUrl = process.env["DRILL_LIVE_URL"];
      if (liveUrl !== undefined && liveUrl !== "")
        live = postgres(liveUrl, { max: 2, onnotice: () => {} });
    });
    afterAll(async () => {
      await restored.end();
      if (live !== undefined) await live.end();
    });

    it("the restored database is what the live system reported at the recovery target", async () => {
      const capture = await readCapture();

      let liveFingerprintAtRestore: string | undefined;
      if (live !== undefined) {
        const ctx = {
          tenantId: capture.tenantId,
          actorId: capture.actorId,
          requestId: await uuidv7(live),
        };
        liveFingerprintAtRestore = await withTenant(live, ctx, (tx) =>
          trialBalanceFingerprint(tx, {
            companyId: capture.companyId,
            fiscalPeriodId: capture.fiscalPeriodId,
          }),
        );
      }

      const verdict = await verifyRestore(restored, {
        capture,
        liveFingerprintAtRestore,
        restoreStartedAt: env("DRILL_RESTORE_STARTED_AT"),
      });

      assertDrillVerdict(verdict, capture);
    }, 300_000);
  },
);
