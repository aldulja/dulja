import { thinRegression } from "../support/regression";

thinRegression(
  "LEGACY-029",
  "The audit trail records no actor and is a freely writable table",
  "packages/db/test/audit.test.ts",
  async ({ db, rw, a, withTenant, expect }) => {
    const ctx = { tenantId: a.tenant, actorId: a.human, requestId: "legacy-029" };
    await withTenant(
      rw,
      ctx,
      (tx) =>
        tx`insert into app.company (tenant_id, code, name, base_currency) values (${a.tenant}, 'LEGACY029', 'LEGACY-029', 'MYR')`,
    );

    const [row] = await db.admin<{ actor_id: string; action: string }[]>`
      select actor_id, action from app.audit_log
       where tenant_id = ${a.tenant} and table_name = 'company' order by seq desc limit 1`;
    expect(row!.actor_id).toBe(a.human); // the session actor, not a parameter
    expect(row!.action).toBe("insert");

    const [priv] = await db.admin<{ upd: boolean; del: boolean }[]>`
      select has_table_privilege('app_rw', 'app.audit_log', 'update') as upd,
             has_table_privilege('app_rw', 'app.audit_log', 'delete') as del`;
    expect(priv).toEqual({ upd: false, del: false }); // append-only, by privilege as well as by trigger
  },
);

// ─── 8A ──────────────────────────────────────────────────────────────────────────────────────────────────
// contracts §3.7.3: 0B created this file; 8A appends and edits no earlier block. `sharedDb()` is ONE database for
// every thin file and `seedTenant` grants `a.human` nothing, so the block grants the three gate codes under a role
// code of its own (the plan's `legacy029-writer`) before it writes a RESTRICTIVE-gated table.
import { Money, currency } from "@dulja/domain";
import {
  createHrKeyRing,
  DEV_HR_KEY,
  openCompensation,
  openStatutoryProfile,
  upsertHrSetting,
  writeSensitive,
} from "@dulja/db";
import {
  grantCodes,
  seedEmployee,
  seedPayComponent,
  seedRateTable,
  seedStatutoryScheme,
} from "@dulja/db/test";
import { sliceRegression } from "../support/regression";

const RING_029 = createHrKeyRing({ current: DEV_HR_KEY, currentVersion: 1 });
const HR_TABLES = [
  "company_hr_setting",
  "compensation_line",
  "employee",
  "employee_sensitive",
  "employee_statutory_profile",
  "pay_component",
  "statutory_rate_table",
  "statutory_scheme",
];

sliceRegression(
  "LEGACY-029",
  "The audit trail records no actor and is a freely writable table",
  "8A",
  "every 8A table writes an audit row whose actor is the SESSION's, and the sensitive images are ciphertext",
  async ({ db, rw, a, withTenant, expect }) => {
    await grantCodes(db, a, {
      codes: ["hr.employee.read_sensitive", "hr.compensation.read", "hr.compensation.manage"],
      principalId: a.human,
      roleCode: "legacy029-writer",
    });
    const [mark] = await db.admin<{ seq: string }[]>`
      select coalesce(max(seq), 0)::text as seq from app.audit_log where tenant_id = ${a.tenant}`;
    const employeeId = await seedEmployee(db, a, { employeeNumber: "E-LEGACY029" });
    const componentId = await seedPayComponent(db, a, { code: "LEGACY029", kind: "earning" });
    const schemeId = await seedStatutoryScheme(db, a, { code: "LEGACY029" });
    await seedRateTable(db, a, { schemeId });
    const ctx = { tenantId: a.tenant, actorId: a.human, requestId: "legacy-029-8a" };
    await withTenant(rw, ctx, async (tx) => {
      // 0080's columns are written by a.human, so `employee` carries a row of this actor too (6C's seeder writes as
      // the system principal).
      await tx`update app.employee set position = 'LEGACY-029' where id = ${employeeId}`;
      await writeSensitive(tx, RING_029, employeeId, { national_id: "SYNTHETIC-ID-029" });
      await openStatutoryProfile(tx, employeeId, {
        effectiveFrom: "2026-01-01",
        maritalStatus: "single",
        spouseWorking: null,
        childReliefCount: 0,
        residencyCategory: null,
        extra: {},
      });
      await openCompensation(tx, {
        employeeId,
        componentId,
        effectiveFrom: "2026-01-01",
        amount: Money.of("1000.0000", currency("MYR")),
        quantity: null,
      });
      await upsertHrSetting(tx, {
        companyId: a.company,
        prorationRule: "calendar_days",
        payDay: 25,
      });
    });
    const rows = await db.admin<{ table_name: string; actor_id: string }[]>`
      select distinct table_name, actor_id from app.audit_log
       where tenant_id = ${a.tenant} and seq > ${mark!.seq}::bigint and table_name = any(${HR_TABLES})
         and actor_id = ${a.human}`;
    expect(rows.map((r) => r.table_name).toSorted()).toEqual(HR_TABLES);
    // No 8A audit row of this block names a principal the session did not carry.
    const strangers = await db.admin<{ actor_id: string }[]>`
      select distinct actor_id from app.audit_log
       where tenant_id = ${a.tenant} and seq > ${mark!.seq}::bigint and table_name = any(${HR_TABLES})
         and actor_id not in (${a.human}, ${a.system})`;
    expect(strangers).toEqual([]);
    // Auditing a sensitive table is safe only because its images are ciphertext.
    const images = await db.admin<{ after: unknown }[]>`
      select after from app.audit_log
       where tenant_id = ${a.tenant} and seq > ${mark!.seq}::bigint and table_name = 'employee_sensitive'`;
    expect(images.length).toBeGreaterThan(0);
    for (const image of images)
      expect(JSON.stringify(image.after)).not.toContain("SYNTHETIC-ID-029");
  },
);
