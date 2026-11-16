import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { JOBS } from "@dulja/db";
import {
  seedRateTable,
  seedStatutoryScheme,
  seedTenant,
  SYNTH_RATE_TABLE_V1,
  type Seed,
} from "@dulja/db/test";
import {
  LAPSE_AUDIT_TABLE,
  LAPSE_HORIZON_DAYS,
  registerRateTableLapse,
} from "../../src/jobs/rate-table-lapse";
import { startWorker, type StartedWorker } from "../support/worker";

describe("hr.rate_table.lapse_warning (spec:2109)", () => {
  let w: StartedWorker;
  let a: Seed;
  let schemeId: string;

  const auditRows = (s: Seed) =>
    w.db.admin<
      { after: { warnings: { schemeCode: string; daysRemaining: number }[] }; actor_id: string }[]
    >`
      select after, actor_id from app.audit_log
       where tenant_id = ${s.tenant} and table_name = ${LAPSE_AUDIT_TABLE} order by seq`;

  beforeAll(async () => {
    w = await startWorker();
    registerRateTableLapse(); // idempotent: startWorker registered it as production does
    a = await seedTenant(w.db, "8a-lapse");
    schemeId = await seedStatutoryScheme(w.db, a, { code: "SYNTH" });
    await seedRateTable(w.db, a, {
      schemeId,
      version: 1,
      verified: true,
      definition: {
        ...SYNTH_RATE_TABLE_V1,
        effective_from: "2026-01-01",
        effective_to: "2026-12-31",
      },
    });
  }, 240_000);
  afterAll(async () => {
    await w.stop();
  });

  it("warns for a table lapsing inside the horizon and writes the sentinel audit row", async () => {
    w.logs.length = 0;
    await w.run("hr.rate_table.lapse_warning", {
      tenantId: a.tenant,
      requestId: "00000000-0000-7000-8000-00000000cc01",
      payload: { asOf: "2026-11-15" },
    });
    const rows = await auditRows(a);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.after.warnings).toHaveLength(1);
    expect(rows[0]!.after.warnings[0]!.schemeCode).toBe("SYNTH");
    expect(rows[0]!.after.warnings[0]!.daysRemaining).toBe(46);
    const warned = w.logs.filter((l) => l.msg === "rate table lapsing");
    expect(warned).toHaveLength(1);
    expect(warned[0]!.level).toBe("warn");
    expect(warned[0]!.fields).toMatchObject({ scheme: "SYNTH", version: 1, days_remaining: 46 });
  });

  it("is silent outside the horizon — no audit row, no log line", async () => {
    w.logs.length = 0;
    await w.run("hr.rate_table.lapse_warning", {
      tenantId: a.tenant,
      requestId: "00000000-0000-7000-8000-00000000cc02",
      payload: { asOf: "2026-06-01" },
    });
    expect(await auditRows(a)).toHaveLength(1);
    expect(w.logs.filter((l) => l.msg === "rate table lapsing")).toEqual([]);
  });

  it("a payload horizon widens the window", async () => {
    await w.run("hr.rate_table.lapse_warning", {
      tenantId: a.tenant,
      requestId: "00000000-0000-7000-8000-00000000cc04",
      payload: { asOf: "2026-06-01", horizonDays: 300 },
    });
    expect(await auditRows(a)).toHaveLength(2);
  });

  it("a verified successor silences the warning", async () => {
    await seedRateTable(w.db, a, {
      schemeId,
      version: 2,
      verified: true,
      definition: {
        ...SYNTH_RATE_TABLE_V1,
        version: 2,
        effective_from: "2027-01-01",
        effective_to: null,
      },
    });
    await w.run("hr.rate_table.lapse_warning", {
      tenantId: a.tenant,
      requestId: "00000000-0000-7000-8000-00000000cc03",
      payload: { asOf: "2026-11-15" },
    });
    expect(await auditRows(a)).toHaveLength(2); // the successor run wrote none
  });

  it("the job's default horizon is sixty days, scheduled daily at 07:00 (spec:2109, §4.2.6)", () => {
    expect(LAPSE_HORIZON_DAYS).toBe(60);
    expect(JOBS["hr.rate_table.lapse_warning"]).toEqual({ schedule: "0 7 * * *", owner: "8A" });
  });

  it("runs as the tenant's SYSTEM principal (hazard 20)", async () => {
    const rows = await auditRows(a);
    expect(rows.every((r) => r.actor_id === a.system)).toBe(true);
  });
});
