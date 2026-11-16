import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createHrKeyRing,
  DEV_HR_KEY,
  HR_KEY_BYTES,
  HrKeyError,
  readSensitive,
  withTenant,
  writeSensitive,
} from "@dulja/db";
import { grantCodes, seedEmployee, seedTenantV2, uuidv7, type Seed } from "@dulja/db/test";
import { setHrKeyRing } from "../../src/hr-keys";
import { startWorker, type StartedWorker } from "../support/worker";

// 8D T7 — the hr.encryption_key.rotate handler through startWorker (spec:2273, ADR 0080, hazard 20). Every value is
// synthetic.
const KEY_V2 = randomBytes(HR_KEY_BYTES).toString("base64");
const RING_V1 = createHrKeyRing({ current: DEV_HR_KEY, currentVersion: 1 });
const RING_V2 = createHrKeyRing({ current: KEY_V2, currentVersion: 2, previous: DEV_HR_KEY });
const RING_V2_ONLY = createHrKeyRing({ current: KEY_V2, currentVersion: 2 });
const HR_CODES = ["hr.employee.read", "hr.employee.read_sensitive", "hr.employee.manage"];

describe("the hr.encryption_key.rotate job — spec:2273, ADR 0080, hazard 20", () => {
  let w: StartedWorker;
  let a: Seed;
  let b: Seed;
  let aIds: string[];
  let bId: string;

  const ctx = async (s: Seed) => ({
    tenantId: s.tenant,
    actorId: s.human,
    requestId: await uuidv7(w.db.admin),
  });
  const rotate = async (s: Seed, payload: { batchSize?: number; companyId?: string }) =>
    w.run("hr.encryption_key.rotate", {
      tenantId: s.tenant,
      requestId: await uuidv7(w.db.admin),
      payload,
    });
  const completions = () => w.logs.filter((l) => l.msg === "hr_key_rotation_complete");

  beforeAll(async () => {
    w = await startWorker();
    a = await seedTenantV2(w.db, "rotate-a");
    b = await seedTenantV2(w.db, "rotate-b");
    for (const s of [a, b]) await grantCodes(w.db, s, { codes: HR_CODES });
    aIds = [
      await seedEmployee(w.db, a, { employeeNumber: "E-5001" }),
      await seedEmployee(w.db, a, { employeeNumber: "E-5002" }),
    ];
    bId = await seedEmployee(w.db, b, { employeeNumber: "E-5003" });
    // Everything is sealed under v1 first, so the rotation has something to move.
    await withTenant(w.db.rw, await ctx(a), async (tx) => {
      for (const [n, id] of aIds.entries())
        await writeSensitive(tx, RING_V1, id, {
          national_id: `SYNTH-A-${n}`,
          bank_account: `SYNTH-ACC-${n}`,
        });
    });
    await withTenant(w.db.rw, await ctx(b), (tx) =>
      writeSensitive(tx, RING_V1, bId, { national_id: "SYNTH-B-0" }),
    );
    // The ring the HANDLER reads. Injected, not environment-set: this is why apps/worker/src/hr-keys.ts is a
    // getter/setter pair rather than a process.env read (8D A12).
    setHrKeyRing(RING_V2);
  }, 300_000);
  afterAll(async () => {
    await w.stop();
  });

  it("rotates every row of the enqueued tenant to key_version 2, in batches of one", async () => {
    await rotate(a, { batchSize: 1 });
    for (const [n, id] of aIds.entries()) {
      // Read back under the NEW key ALONE: a column still sealed under v1 would make openField ask the ring for a
      // key it does not carry and throw. Passing is the round trip.
      const row = await withTenant(w.db.rw, await ctx(a), (tx) =>
        readSensitive(tx, RING_V2_ONLY, id),
      );
      expect(row?.keyVersion, `employee ${n}`).toBe(2);
      expect(row?.values.national_id).toBe(`SYNTH-A-${n}`);
      expect(row?.values.bank_account).toBe(`SYNTH-ACC-${n}`);
    }
  });

  it("leaves the OTHER tenant's row at key_version 1 — the job is tenant-scoped (test 12's shape)", async () => {
    const row = await withTenant(w.db.rw, await ctx(b), (tx) => readSensitive(tx, RING_V1, bId));
    expect(row?.keyVersion).toBe(1);
    expect(row?.values.national_id).toBe("SYNTH-B-0");
  });

  it("runs as the tenant's system principal: every re-sealed row is stamped and audited under it", async () => {
    const stamped = await w.db.admin<{ updated_by: string }[]>`
      select updated_by from app.employee_sensitive where tenant_id = ${a.tenant}`;
    expect(stamped.map((r) => r.updated_by)).toEqual([a.system, a.system]);
    const [audit] = await w.db.admin<{ n: number }[]>`
      select count(*)::int as n from app.audit_log
       where tenant_id = ${a.tenant} and table_name = 'employee_sensitive' and action = 'update'
         and actor_id = ${a.system}`;
    expect(audit!.n).toBe(2);
  });

  it("logs one hr_key_rotation_complete line with the counts and the new version", () => {
    const lines = completions();
    expect(lines).toHaveLength(1);
    expect(lines[0]!.level).toBe("info");
    expect(lines[0]!.fields).toMatchObject({
      tenant_id: a.tenant,
      rotated: 2,
      scanned: 2,
      key_version: 2,
      complete: true,
    });
    expect(Number(lines[0]!.fields["batches"])).toBe(3); // batchSize 1 over two rows, then the empty batch
  });

  it("puts no key material and no secret-shaped field name in the log (forbidden-log-fields' runtime twin)", () => {
    for (const line of w.logs) {
      for (const [key, value] of Object.entries(line.fields)) {
        expect(key, `${key} is a forbidden log field (§4.2.3)`).not.toMatch(
          /token|password|authorization|card|pin|secret/i,
        );
        if (typeof value === "string") {
          expect(value).not.toBe(KEY_V2);
          expect(value).not.toMatch(/SYNTH-/);
        }
      }
    }
  });

  it("a second run is a no-op — the key_version < current predicate makes it idempotent", async () => {
    const before = completions().length;
    await rotate(a, {});
    const line = completions().slice(before)[0];
    expect(line?.fields).toMatchObject({ rotated: 0, scanned: 0, batches: 1 });
  });

  it("companyId narrows the run to that company; another company's id rotates nothing", async () => {
    const before = completions().length;
    await rotate(b, { companyId: a.company });
    expect(completions().slice(before)[0]?.fields).toMatchObject({ rotated: 0, scanned: 0 });
    await rotate(b, { companyId: b.company });
    expect(completions().slice(before)[1]?.fields).toMatchObject({ rotated: 1, scanned: 1 });
    const row = await withTenant(w.db.rw, await ctx(b), (tx) =>
      readSensitive(tx, RING_V2_ONLY, bId),
    );
    expect(row?.values.national_id).toBe("SYNTH-B-0");
  });

  it("refuses a batch size outside 1–5000 before touching a row", async () => {
    for (const batchSize of [0, 5001, 1.5])
      await expect(rotate(a, { batchSize })).rejects.toThrow(RangeError);
  });

  it("without the previous key the job fails loudly and leaves the row as it was", async () => {
    const c = await seedTenantV2(w.db, "rotate-c");
    await grantCodes(w.db, c, { codes: HR_CODES });
    const id = await seedEmployee(w.db, c, { employeeNumber: "E-5004" });
    await withTenant(w.db.rw, await ctx(c), (tx) =>
      writeSensitive(tx, RING_V1, id, { national_id: "SYNTH-C-0" }),
    );
    setHrKeyRing(RING_V2_ONLY);
    try {
      await expect(rotate(c, {})).rejects.toThrow(HrKeyError);
    } finally {
      setHrKeyRing(RING_V2);
    }
    const row = await withTenant(w.db.rw, await ctx(c), (tx) => readSensitive(tx, RING_V1, id));
    expect(row?.keyVersion).toBe(1);
  });
});
