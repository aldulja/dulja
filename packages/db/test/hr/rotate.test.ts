import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { createHrKeyRing, DEV_HR_KEY, HR_KEY_BYTES, HrKeyError } from "../../src/hr/keys";
import { readSensitive, writeSensitive } from "../../src/hr/employee-sensitive";
import { rotateSensitiveBatch } from "../../src/hr/rotate";
import { grantCodes, seedEmployee, seedTenantV2, type Seed } from "../fixtures";
import { startDb, uuidv7, withTenant, type Db } from "../harness";

// 8D T7 — spec:2273, ADR 0080. Every value is synthetic (`SYNTH-…`); no real identifier appears.
const KEY_V2 = randomBytes(HR_KEY_BYTES).toString("base64");
const RING_V1 = createHrKeyRing({ current: DEV_HR_KEY, currentVersion: 1 });
const RING_V2 = createHrKeyRing({
  current: KEY_V2,
  currentVersion: 2,
  previous: DEV_HR_KEY,
  previousVersion: 1,
});
const RING_V2_ONLY = createHrKeyRing({ current: KEY_V2, currentVersion: 2 });
const HR_CODES = ["hr.employee.read", "hr.employee.read_sensitive", "hr.employee.manage"];

describe("rotateSensitiveBatch — spec:2273, ADR 0080", () => {
  let db: Db;
  let s: Seed;
  let ids: string[];
  let before: Map<string, Buffer>;

  beforeAll(async () => {
    db = await startDb();
    s = await seedTenantV2(db, "hr-rotate");
    // A company-wide live role: 6C's Form A′ hides every employee from a principal with none (8A's decision).
    await grantCodes(db, s, { codes: HR_CODES });
    ids = [];
    for (let i = 1; i <= 5; i += 1)
      ids.push(await seedEmployee(db, s, { employeeNumber: `E-30${i}` }));
    await withTenant(db.rw, s.tenant, s.human, async (tx) => {
      for (const [n, id] of ids.entries()) {
        await writeSensitive(tx, RING_V1, id, {
          national_id: `SYNTH-ID-${n}`,
          bank_account: `SYNTH-ACC-${n}`,
          work_permit_expiry: n === 0 ? "2026-06-30" : null,
        });
      }
    });
    before = new Map(
      (
        await db.admin<{ employee_id: string; national_id_enc: Buffer }[]>`
          select employee_id, national_id_enc from app.employee_sensitive where tenant_id = ${s.tenant}`
      ).map((r) => [r.employee_id, r.national_id_enc]),
    );
  }, 180_000);
  afterAll(async () => {
    await db.stop();
  });

  it("refuses a batch size that is not a positive integer", async () => {
    for (const batchSize of [0, -1, 1.5]) {
      await expect(
        withTenant(db.rw, s.tenant, s.human, (tx) =>
          rotateSensitiveBatch(tx, RING_V2, { batchSize, afterEmployeeId: null }),
        ),
      ).rejects.toThrow(RangeError);
    }
  });

  it("a principal without hr.employee.read_sensitive sees no row to rotate — sensitive_gate bounds the job's reads", async () => {
    // A principal of the SAME tenant holding a live role without the sensitive code (8A's bystander shape).
    const clerk = await uuidv7(db.admin);
    await withTenant(db.migrator, s.tenant, s.system, async (tx) => {
      await tx`insert into app.principal (id, auth_subject, kind, display_name)
               values (${clerk}, ${`sub-${clerk}`}, 'human', 'Rotate clerk')`;
      await tx`insert into app.membership (tenant_id, principal_id) values (${s.tenant}, ${clerk})`;
    });
    await grantCodes(db, s, { codes: ["hr.employee.read"], principalId: clerk });
    const batch = await withTenant(db.rw, s.tenant, clerk, (tx) =>
      rotateSensitiveBatch(tx, RING_V2, { batchSize: 100, afterEmployeeId: null }),
    );
    expect(batch).toEqual({ scanned: 0, rotated: 0, lastEmployeeId: null });
  });

  it("rotates in bounded batches and reports a keyset cursor", async () => {
    const first = await withTenant(db.rw, s.tenant, s.system, (tx) =>
      rotateSensitiveBatch(tx, RING_V2, { batchSize: 2, afterEmployeeId: null }),
    );
    expect(first.scanned).toBe(2);
    expect(first.rotated).toBe(2);
    expect(first.lastEmployeeId).toBe([...ids].toSorted()[1]);

    let cursor = first.lastEmployeeId;
    let rotated = first.rotated;
    let batches = 1;
    for (let i = 0; i < 5 && cursor !== null; i += 1) {
      const b = await withTenant(db.rw, s.tenant, s.system, (tx) =>
        rotateSensitiveBatch(tx, RING_V2, { batchSize: 2, afterEmployeeId: cursor }),
      );
      rotated += b.rotated;
      cursor = b.lastEmployeeId;
      batches += 1;
    }
    expect(rotated).toBe(5);
    expect(batches).toBe(4); // 2 + 2 + 1, then the empty batch that ends the walk
  });

  it("every value round-trips under the NEW key alone, key_version is 2, and every ciphertext changed", async () => {
    for (const [n, id] of ids.entries()) {
      const row = await withTenant(db.rw, s.tenant, s.human, (tx) =>
        readSensitive(tx, RING_V2_ONLY, id),
      );
      expect(row?.keyVersion, `employee ${n}`).toBe(2);
      expect(row?.values.national_id).toBe(`SYNTH-ID-${n}`);
      expect(row?.values.bank_account).toBe(`SYNTH-ACC-${n}`);
      expect(row?.values.work_permit_expiry ?? null).toBe(n === 0 ? "2026-06-30" : null);
    }
    const after = await db.admin<{ employee_id: string; national_id_enc: Buffer }[]>`
      select employee_id, national_id_enc from app.employee_sensitive where tenant_id = ${s.tenant}`;
    for (const r of after) {
      expect(r.national_id_enc[0]).toBe(2);
      expect(r.national_id_enc.equals(before.get(r.employee_id)!)).toBe(false);
    }
  });

  it("a NULL column stays NULL and does not become an envelope over the empty string", async () => {
    const [raw] = await db.admin<
      { passport_enc: Buffer | null; work_permit_expiry_enc: Buffer | null }[]
    >`
      select passport_enc, work_permit_expiry_enc from app.employee_sensitive where employee_id = ${ids[1]!}`;
    expect(raw!.passport_enc).toBeNull();
    expect(raw!.work_permit_expiry_enc).toBeNull();
  });

  it("the update is stamped and audited under the job's system principal (hazard 20)", async () => {
    const [row] = await db.admin<{ updated_by: string }[]>`
      select updated_by from app.employee_sensitive where employee_id = ${ids[0]!}`;
    expect(row!.updated_by).toBe(s.system);
    const [audit] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from app.audit_log
       where tenant_id = ${s.tenant} and table_name = 'employee_sensitive' and action = 'update'
         and actor_id = ${s.system}`;
    expect(audit!.n).toBe(5);
  });

  it("a second pass is a no-op — rotation is idempotent", async () => {
    const again = await withTenant(db.rw, s.tenant, s.system, (tx) =>
      rotateSensitiveBatch(tx, RING_V2, { batchSize: 100, afterEmployeeId: null }),
    );
    expect(again).toEqual({ scanned: 0, rotated: 0, lastEmployeeId: null });
  });

  it("repairs a half-moved row: each column opens under its OWN byte-0 version, and a current one is kept as is", async () => {
    const t = await seedTenantV2(db, "hr-rotate-mixed");
    await grantCodes(db, t, { codes: HR_CODES });
    const id = await seedEmployee(db, t, { employeeNumber: "E-3101" });
    await withTenant(db.rw, t.tenant, t.human, async (tx) => {
      await writeSensitive(tx, RING_V1, id, { national_id: "SYNTH-MIX", passport: "SYNTH-P1" });
      // A partial write under the new ring: `passport` moves to v2, `national_id` stays v1, key_version stays 1.
      await writeSensitive(tx, RING_V2, id, { passport: "SYNTH-P2" });
    });
    const [mixed] = await db.admin<
      { key_version: number; passport_enc: Buffer; national_id_enc: Buffer }[]
    >`
      select key_version, passport_enc, national_id_enc from app.employee_sensitive where employee_id = ${id}`;
    expect(mixed!.key_version).toBe(1);
    expect([mixed!.national_id_enc[0], mixed!.passport_enc[0]]).toEqual([1, 2]);

    const batch = await withTenant(db.rw, t.tenant, t.system, (tx) =>
      rotateSensitiveBatch(tx, RING_V2, { batchSize: 10, afterEmployeeId: null }),
    );
    expect(batch.rotated).toBe(1);
    const [done] = await db.admin<
      { key_version: number; passport_enc: Buffer; national_id_enc: Buffer }[]
    >`
      select key_version, passport_enc, national_id_enc from app.employee_sensitive where employee_id = ${id}`;
    expect(done!.key_version).toBe(2);
    expect(done!.national_id_enc[0]).toBe(2);
    expect(done!.passport_enc.equals(mixed!.passport_enc)).toBe(true);
    const row = await withTenant(db.rw, t.tenant, t.human, (tx) =>
      readSensitive(tx, RING_V2_ONLY, id),
    );
    expect(row?.values).toMatchObject({ national_id: "SYNTH-MIX", passport: "SYNTH-P2" });
  });

  it("companyId narrows the batch to that company's employees", async () => {
    const t = await seedTenantV2(db, "hr-rotate-company");
    await grantCodes(db, t, { codes: HR_CODES });
    const id = await seedEmployee(db, t, { employeeNumber: "E-3201" });
    await withTenant(db.rw, t.tenant, t.human, (tx) =>
      writeSensitive(tx, RING_V1, id, { national_id: "SYNTH-CO" }),
    );
    const elsewhere = await withTenant(db.rw, t.tenant, t.system, (tx) =>
      rotateSensitiveBatch(tx, RING_V2, {
        batchSize: 10,
        afterEmployeeId: null,
        companyId: "00000000-0000-7000-8000-000000000000",
      }),
    );
    expect(elsewhere.scanned).toBe(0);
    const here = await withTenant(db.rw, t.tenant, t.system, (tx) =>
      rotateSensitiveBatch(tx, RING_V2, {
        batchSize: 10,
        afterEmployeeId: null,
        companyId: t.company,
      }),
    );
    expect(here.rotated).toBe(1);
  });

  it("without the PREVIOUS key the rotation refuses loudly and writes nothing", async () => {
    const other = await seedTenantV2(db, "hr-rotate-b");
    await grantCodes(db, other, { codes: HR_CODES });
    const id = await seedEmployee(db, other, { employeeNumber: "E-9001" });
    await withTenant(db.rw, other.tenant, other.human, (tx) =>
      writeSensitive(tx, RING_V1, id, { national_id: "SYNTH-ID-X" }),
    );
    await expect(
      withTenant(db.rw, other.tenant, other.system, (tx) =>
        rotateSensitiveBatch(tx, RING_V2_ONLY, { batchSize: 10, afterEmployeeId: null }),
      ),
    ).rejects.toThrow(HrKeyError);
    const row = await withTenant(db.rw, other.tenant, other.human, (tx) =>
      readSensitive(tx, RING_V1, id),
    );
    expect(row?.keyVersion).toBe(1);
    expect(row?.values.national_id).toBe("SYNTH-ID-X");
  });
});
