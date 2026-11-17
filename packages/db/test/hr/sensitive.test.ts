import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHrKeyRing, DEV_HR_KEY, HrKeyError } from "../../src/hr/keys";
import { openField, sealField, SENSITIVE_FIELDS } from "../../src/hr/sensitive";
import {
  readSensitive,
  writeSensitive,
  type SensitiveValues,
} from "../../src/hr/employee-sensitive";
import { lintSchema } from "../../src/lint-schema";
import { grantCodes, seedEmployee, seedTenant, type Seed } from "../fixtures";
import { startDb, uuidv7, withTenant, type Db } from "../harness";

const ring = createHrKeyRing({ current: DEV_HR_KEY, currentVersion: 1 });
/** A second, clearly synthetic key so the rotation case has two versions to move between. 8D's rotation job
 *  supplies the real pair through HR_FIELD_ENCRYPTION_KEY / …_PREVIOUS. */
const KEY_V2 = Buffer.alloc(32, 1).toString("base64");
const ringV2 = createHrKeyRing({
  current: KEY_V2,
  currentVersion: 2,
  previous: DEV_HR_KEY,
  previousVersion: 1,
});

describe("the HR key ring (8A amendment A8)", () => {
  it("refuses a key that is not base64 of exactly 32 bytes, naming the variable", () => {
    expect(() =>
      createHrKeyRing({ current: Buffer.alloc(16).toString("base64"), currentVersion: 1 }),
    ).toThrow(/HR_FIELD_ENCRYPTION_KEY decodes to 16 bytes; exactly 32/);
    expect(() => createHrKeyRing({ current: "not base64 at all!", currentVersion: 1 })).toThrow(
      /HR_FIELD_ENCRYPTION_KEY is not valid base64/,
    );
    expect(() =>
      createHrKeyRing({
        current: DEV_HR_KEY,
        currentVersion: 2,
        previous: "c2hvcnQ=",
        previousVersion: 1,
      }),
    ).toThrow(/HR_FIELD_ENCRYPTION_KEY_PREVIOUS decodes to 5 bytes/);
  });

  it("a version the ring does not hold is an operator fault (HrKeyError), never a caller code", () => {
    expect(() => ring.forVersion(7)).toThrow(HrKeyError);
    const sealed = sealField(ringV2, "00000000-0000-7000-8000-000000000001", "passport", "X");
    expect(() =>
      openField(ring, "00000000-0000-7000-8000-000000000001", "passport", sealed),
    ).toThrow(/no HR key for version 2/);
  });
});

describe("migration 0081 — employee_sensitive is ciphertext behind a RESTRICTIVE gate", () => {
  let db: Db;
  let a: Seed;
  let b: Seed;
  let holder: string;
  let holder2: string;
  let bystander: string;
  let employeeId: string;

  beforeAll(async () => {
    db = await startDb();
    a = await seedTenant(db, "8a-sens-a");
    b = await seedTenant(db, "8a-sens-b");
    holder = await uuidv7(db.admin);
    holder2 = await uuidv7(db.admin);
    bystander = await uuidv7(db.admin);
    await withTenant(db.migrator, a.tenant, a.system, async (tx) => {
      for (const [id, name] of [
        [holder, "Holder"],
        [holder2, "Second holder"],
        [bystander, "Bystander"],
      ] as const) {
        await tx`insert into app.principal (id, auth_subject, kind, display_name)
                 values (${id}, ${`sub-${id}`}, 'human', ${name})`;
        await tx`insert into app.membership (tenant_id, principal_id) values (${a.tenant}, ${id})`;
      }
    });
    await grantCodes(db, a, {
      codes: ["hr.employee.read_sensitive"],
      principalId: holder,
      roleCode: "t-sens-holder",
    });
    // A SECOND holder of the same code, for the updated_by case below: A19's always-stamp is only observable
    // when a row is rewritten by somebody other than the principal that created it.
    await grantCodes(db, a, {
      codes: ["hr.employee.read_sensitive"],
      principalId: holder2,
      roleCode: "t-sens-holder-2",
    });
    // `bystander` holds a live role in the company carrying NO code. On this branch app.employee carries 6C's
    // Form A′ branch_isolation (0068), so a principal with no role at all could not even see the employee and
    // its write would be a silent no-op; the empty role is what makes the refusal below sensitive_gate's own,
    // not branch isolation's (contracts round 16, A21).
    await grantCodes(db, a, { principalId: bystander, roleCode: "t-sens-bystander" });
    await grantCodes(db, b);
    employeeId = await seedEmployee(db, a, { employeeNumber: "E-SENS" });
  }, 180_000);
  afterAll(async () => {
    await db.stop();
  });

  it("the envelope round-trips and is bound to the employee and the column (§4.12.5)", () => {
    const sealed = sealField(ring, employeeId, "national_id", "SYNTHETIC-ID-0001");
    expect(sealed[0]).toBe(1); // version byte
    expect(sealed.length).toBe(1 + 12 + "SYNTHETIC-ID-0001".length + 16);
    expect(openField(ring, employeeId, "national_id", sealed)).toBe("SYNTHETIC-ID-0001");
    expect(() => openField(ring, employeeId, "passport", sealed)).toThrow(HrKeyError); // wrong AAD column
    expect(() =>
      openField(ring, "00000000-0000-7000-8000-000000000000", "national_id", sealed),
    ).toThrow(HrKeyError); // moved to another employee
    const tampered = Buffer.from(sealed);
    tampered[20] = tampered[20]! ^ 0xff;
    expect(() => openField(ring, employeeId, "national_id", tampered)).toThrow(HrKeyError);
  });

  it("a holder of hr.employee.read_sensitive can write and read every field back", async () => {
    await withTenant(db.rw, a.tenant, holder, (tx) =>
      writeSensitive(tx, ring, employeeId, {
        national_id: "SYNTHETIC-ID-0001",
        bank_account: "SYNTHETIC-ACC-9",
        work_permit_expiry: "2027-01-31",
      }),
    );
    const row = await withTenant(db.rw, a.tenant, holder, (tx) =>
      readSensitive(tx, ring, employeeId),
    );
    expect(row?.values.national_id).toBe("SYNTHETIC-ID-0001");
    expect(row?.values.bank_account).toBe("SYNTHETIC-ACC-9");
    expect(row?.values.work_permit_expiry).toBe("2027-01-31");
    expect(row?.values.passport).toBeNull();
    expect(row?.keyVersion).toBe(1);
    expect(row?.updatedBy).toBe(holder); // stamped, never supplied
  });

  it("updated_by names the LAST writer, not the first — the A19 always-stamp", async () => {
    // Under the write-once app_meta.attach_stamp this row's updated_by would still read `holder` after the
    // second write, so the column would name the creator forever while updated_at moved — LEGACY-044's shape.
    const before = await withTenant(db.rw, a.tenant, holder, (tx) =>
      readSensitive(tx, ring, employeeId),
    );
    expect(before?.updatedBy).toBe(holder);
    await withTenant(db.rw, a.tenant, holder2, (tx) =>
      writeSensitive(tx, ring, employeeId, { bank_account: "SYNTHETIC-ACC-CHANGED" }),
    );
    const after = await withTenant(db.rw, a.tenant, holder2, (tx) =>
      readSensitive(tx, ring, employeeId),
    );
    expect(after?.updatedBy).toBe(holder2); // the SECOND writer, not the first
    expect(after?.values.bank_account).toBe("SYNTHETIC-ACC-CHANGED");
    expect(after?.values.national_id).toBe("SYNTHETIC-ID-0001"); // an untouched field is untouched
    expect(Date.parse(after!.updatedAt)).toBeGreaterThanOrEqual(Date.parse(before!.updatedAt));
    // and a caller cannot supply it either: the trigger overwrites whatever arrives.
    await withTenant(
      db.rw,
      a.tenant,
      holder,
      (tx) => tx`
      update app.employee_sensitive set updated_by = ${holder2} where employee_id = ${employeeId}`,
    );
    const [claimed] = await db.admin<{ updated_by: string }[]>`
      select updated_by from app.employee_sensitive where employee_id = ${employeeId}`;
    expect(claimed!.updated_by).toBe(holder); // the SESSION's actor, not the claim
  });

  it("a PARTIAL write under a newer key does not advance key_version; a FULL one does (ADR 0071)", async () => {
    const rot = await seedEmployee(db, a, { employeeNumber: "E-SENS-ROT" });
    await withTenant(db.rw, a.tenant, holder, (tx) =>
      writeSensitive(tx, ring, rot, {
        national_id: "SYNTHETIC-ID-ROT",
        passport: "SYNTHETIC-PP-ROT",
      }),
    );
    // one field re-sealed under version 2; the other columns are still sealed under version 1
    await withTenant(db.rw, a.tenant, holder, (tx) =>
      writeSensitive(tx, ringV2, rot, { national_id: "SYNTHETIC-ID-ROT2" }),
    );
    const partial = await withTenant(db.rw, a.tenant, holder, (tx) =>
      readSensitive(tx, ringV2, rot),
    );
    expect(partial?.keyVersion).toBe(1); // the OLDEST version still in the row
    expect(partial?.values.national_id).toBe("SYNTHETIC-ID-ROT2"); // opened with the v2 key
    expect(partial?.values.passport).toBe("SYNTHETIC-PP-ROT"); // opened with the v1 key, same ring
    // a rotation batch re-seals every field, and only then does the row's stamp move
    await withTenant(db.rw, a.tenant, holder, (tx) =>
      writeSensitive(
        tx,
        ringV2,
        rot,
        Object.fromEntries(
          SENSITIVE_FIELDS.map((f) => [f, partial!.values[f] ?? null]),
        ) as SensitiveValues,
      ),
    );
    const full = await withTenant(db.rw, a.tenant, holder, (tx) => readSensitive(tx, ringV2, rot));
    expect(full?.keyVersion).toBe(2);
    expect(full?.values.passport).toBe("SYNTHETIC-PP-ROT");
  });

  it("what is stored is ciphertext — the plaintext is nowhere in the row (spec:2211)", async () => {
    const [raw] = await db.admin<{ hex: string }[]>`
      select encode(national_id_enc, 'hex') as hex from app.employee_sensitive where employee_id = ${employeeId}`;
    expect(raw!.hex).not.toContain(Buffer.from("SYNTHETIC-ID-0001", "utf8").toString("hex"));
  });

  it("sensitive_gate: a principal WITHOUT the code gets zero rows by direct app_rw SQL (test 32, LEGACY-033)", async () => {
    // The bystander can see the EMPLOYEE (a live role in the company) and still sees no sensitive row.
    const employees = await withTenant(
      db.rw,
      a.tenant,
      bystander,
      (tx) => tx<{ id: string }[]>`select id from app.employee where id = ${employeeId}`,
    );
    expect(employees).toHaveLength(1);
    const rows = await withTenant(
      db.rw,
      a.tenant,
      bystander,
      (tx) => tx<{ employee_id: string }[]>`select employee_id from app.employee_sensitive`,
    );
    expect(rows).toHaveLength(0);
    expect(
      await withTenant(db.rw, a.tenant, bystander, (tx) => readSensitive(tx, ring, employeeId)),
    ).toBeNull();
  });

  it("sensitive_gate has no with check, so the same predicate refuses a WRITE", async () => {
    const other = await seedEmployee(db, a, { employeeNumber: "E-SENS-2" });
    await expect(
      withTenant(db.rw, a.tenant, bystander, (tx) =>
        writeSensitive(tx, ring, other, { national_id: "X" }),
      ),
    ).rejects.toThrow(/row-level security|42501/);
    // …and an existing row cannot be overwritten either.
    await expect(
      withTenant(db.rw, a.tenant, bystander, (tx) =>
        writeSensitive(tx, ring, employeeId, { national_id: "X" }),
      ),
    ).rejects.toThrow(/row-level security|42501/);
  });

  it("the system principal passes the gate, so jobs still run (spec:2076)", async () => {
    const rows = await withTenant(
      db.rw,
      a.tenant,
      a.system,
      (tx) => tx<{ employee_id: string }[]>`select employee_id from app.employee_sensitive`,
    );
    expect(rows.length).toBeGreaterThan(0);
  });

  it("R4: a principal cannot write their own sensitive row (spec:2175)", async () => {
    const mine = await seedEmployee(db, a, { employeeNumber: "E-SENS-SELF", principalId: holder });
    await expect(
      withTenant(db.rw, a.tenant, holder, (tx) =>
        writeSensitive(tx, ring, mine, { national_id: "SYNTHETIC-ID-SELF" }),
      ),
    ).rejects.toThrow(/ERR_HR_SELF_PAY/);
    // another holder may write it
    await withTenant(db.rw, a.tenant, holder2, (tx) =>
      writeSensitive(tx, ring, mine, { national_id: "SYNTHETIC-ID-SELF" }),
    );
    // …and the subject still cannot change it afterwards (the UPDATE path)
    await expect(
      withTenant(db.rw, a.tenant, holder, (tx) =>
        writeSensitive(tx, ring, mine, { bank_account: "SYNTHETIC-ACC-SELF" }),
      ),
    ).rejects.toThrow(/ERR_HR_SELF_PAY/);
  });

  it("tenant B sees nothing of tenant A, code or no code (test 12)", async () => {
    const rows = await withTenant(
      db.rw,
      b.tenant,
      b.human,
      (tx) => tx<{ employee_id: string }[]>`
        select employee_id from app.employee_sensitive where employee_id = ${employeeId}`,
    );
    expect(rows).toHaveLength(0);
    const sys = await withTenant(
      db.rw,
      b.tenant,
      b.system,
      (tx) => tx<{ employee_id: string }[]>`
        select employee_id from app.employee_sensitive where employee_id = ${employeeId}`,
    );
    expect(sys).toHaveLength(0);
  });

  it("the table is audited, is not immutable, and has no id column (§3.5.3)", async () => {
    const cols = await db.admin<{ column_name: string }[]>`
      select column_name from information_schema.columns where table_schema = 'app' and table_name = 'employee_sensitive'`;
    expect(cols.map((c) => c.column_name)).not.toContain("id");
    expect(cols.map((c) => c.column_name)).toContain("created_at");
    const trg = await db.admin<{ tgname: string }[]>`
      select t.tgname from pg_trigger t join pg_class c on c.oid = t.tgrelid
       where not t.tgisinternal and c.relname = 'employee_sensitive'`;
    expect(trg.map((t) => t.tgname).toSorted()).toEqual(
      ["audit_row", "employee_sensitive_no_self_pay", "stamp_updated_by"].toSorted(),
    );
    const [n] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from app.audit_log where table_name = 'employee_sensitive'`;
    expect(n!.n).toBeGreaterThan(0); // ciphertext before/after images are wanted (§3.5.3)
    const [audited] = await db.admin<{ row_id: string; after: Record<string, unknown> }[]>`
      select row_id, after from app.audit_log where table_name = 'employee_sensitive' order by seq desc limit 1`;
    expect(audited!.row_id).toMatch(/^[0-9a-f-]{36}$/); // keyed on employee_id, not a null id
    expect(JSON.stringify(audited!.after)).not.toContain("SYNTHETIC");
  });

  it("the schema linter reports zero violations, and reports one when the gate is dropped", async () => {
    expect(await lintSchema(db.admin)).toEqual([]);
    await db.admin`drop policy sensitive_gate on app.employee_sensitive`;
    await db.admin`create policy sensitive_gate on app.employee_sensitive as permissive
      using (app.actor_has('hr.employee.read_sensitive', (select e.company_id from app.employee e where e.id = employee_id)))`;
    const permissive = await lintSchema(db.admin);
    expect(permissive).toContainEqual({
      table: "employee_sensitive",
      rule: "sensitive_gate",
      detail:
        "no RESTRICTIVE policy named sensitive_gate (spec:2076 — a permission gate is OR-ed away when permissive, LEGACY-033)",
    });
    await db.admin`drop policy sensitive_gate on app.employee_sensitive`;
    const v = await lintSchema(db.admin);
    expect(v).toContainEqual({
      table: "employee_sensitive",
      rule: "sensitive_gate",
      detail:
        "no RESTRICTIVE policy named sensitive_gate (spec:2076 — a permission gate is OR-ed away when permissive, LEGACY-033)",
    });
    await db.admin`create policy sensitive_gate on app.employee_sensitive as restrictive
      using (app.actor_has('hr.employee.read_sensitive', (select e.company_id from app.employee e where e.id = employee_id)))`;
    expect(await lintSchema(db.admin)).toEqual([]);
  });
});
