import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedStatutoryScheme, seedTenantV2, withTenant } from "@dulja/db/test";
import { startApi } from "../../support/app";
import { problemOf } from "../../../../../tests/support/api"; // 0B's, imported directly
import { hrFixture, type HrFixture } from "../../../../../tests/invariants/support/hr";

interface Dto {
  companyId: string;
  prorationRule: string;
  payDay: number | null;
  employerRegistrations: { schemeId: string; schemeCode: string; registration: string | null }[];
}

describe("GET|PUT /v1/companies/{companyId}/hr-settings (⚠️ OD-23)", () => {
  let f: HrFixture;
  const path = () => `/v1/companies/${f.companyId}/hr-settings`;
  beforeAll(async () => {
    f = await hrFixture(await startApi(), "hr-settings");
  }, 240_000);
  afterAll(async () => {
    await f.api.stop();
  });

  it("reads the §2.12 default before anything is stored, and lists every scheme unregistered", async () => {
    const res = await f.api.request({ method: "GET", path: path(), as: f.officer });
    expect(res.status).toBe(200);
    const dto = (await res.json()) as Dto;
    expect(dto.companyId).toBe(f.companyId);
    expect(dto.prorationRule).toBe("calendar_days");
    expect(dto.payDay).toBeNull();
    expect(dto.employerRegistrations.map((r) => r.schemeId)).toContain(f.schemeId);
    expect(dto.employerRegistrations.every((r) => r.registration === null)).toBe(true);
  });

  it("stores the rule, the pay day and one registration in a single PUT", async () => {
    const res = await f.api.request({
      method: "PUT",
      path: path(),
      as: f.officer,
      body: {
        prorationRule: "working_days",
        payDay: 25,
        employerRegistrations: [{ schemeId: f.schemeId, registration: "SYNTHETIC-REG-0001" }],
      },
    });
    expect(res.status).toBe(200);
    const dto = (await res.json()) as Dto;
    expect(dto.prorationRule).toBe("working_days");
    expect(dto.payDay).toBe(25);
    expect(dto.employerRegistrations.find((r) => r.schemeId === f.schemeId)!.registration).toBe(
      "SYNTHETIC-REG-0001",
    );
    const again = (await (
      await f.api.request({ method: "GET", path: path(), as: f.officer })
    ).json()) as Dto;
    expect(again).toEqual(dto);
    // The registration's one home is the scheme row (amendment A3).
    const [row] = await f.db.admin<{ employer_registration: string | null }[]>`
      select employer_registration from app.statutory_scheme where id = ${f.schemeId}`;
    expect(row!.employer_registration).toBe("SYNTHETIC-REG-0001");
  });

  it("a PUT without registrations leaves the stored ones alone; a null clears one", async () => {
    const kept = await f.api.request({
      method: "PUT",
      path: path(),
      as: f.officer,
      body: { prorationRule: "calendar_days", payDay: null },
    });
    expect(kept.status).toBe(200);
    const dto = (await kept.json()) as Dto;
    expect(dto.payDay).toBeNull();
    expect(dto.employerRegistrations.find((r) => r.schemeId === f.schemeId)!.registration).toBe(
      "SYNTHETIC-REG-0001",
    );
    const cleared = await f.api.request({
      method: "PUT",
      path: path(),
      as: f.officer,
      body: {
        prorationRule: "calendar_days",
        payDay: null,
        employerRegistrations: [{ schemeId: f.schemeId, registration: null }],
      },
    });
    expect(
      ((await cleared.json()) as Dto).employerRegistrations.find((r) => r.schemeId === f.schemeId)!
        .registration,
    ).toBeNull();
  });

  it("a third proration rule is ERR_VALIDATION_FAILED at the Zod layer (spec:2086)", async () => {
    const res = await f.api.request({
      method: "PUT",
      path: path(),
      as: f.officer,
      body: { prorationRule: "thirty_days", payDay: 25 },
    });
    expect(res.status).toBe(400);
    expect((await problemOf(res)).code).toBe("ERR_VALIDATION_FAILED");
  });

  it("a pay day outside 1..31 and an unknown body member are refused before the CHECK", async () => {
    for (const body of [
      { prorationRule: "calendar_days", payDay: 32 },
      { prorationRule: "calendar_days", payDay: 1, employerRegistrationsBlob: {} },
    ]) {
      const res = await f.api.request({ method: "PUT", path: path(), as: f.officer, body });
      expect(res.status).toBe(400);
      expect((await problemOf(res)).code).toBe("ERR_VALIDATION_FAILED");
    }
  });

  it("a scheme of ANOTHER company of the tenant is 404, and nothing is written", async () => {
    const other = await withTenant(f.db.migrator, f.seed.tenant, f.seed.system, async (tx) => {
      const [company] = await tx<{ id: string }[]>`
        insert into app.company (tenant_id, code, name, base_currency)
        values (${f.seed.tenant}, 'HR-SIB', 'Sibling company', 'MYR') returning id`;
      return company!.id;
    });
    const sibling = await seedStatutoryScheme(
      f.db,
      { ...f.seed, company: other },
      { code: "SIBLING" },
    );
    const res = await f.api.request({
      method: "PUT",
      path: path(),
      as: f.officer,
      body: {
        prorationRule: "working_days",
        payDay: 7,
        employerRegistrations: [{ schemeId: sibling, registration: "SYNTHETIC-REG-SIB" }],
      },
    });
    expect(res.status).toBe(404);
    expect((await problemOf(res)).code).toBe("ERR_NOT_FOUND");
    const [row] = await f.db.admin<{ employer_registration: string | null }[]>`
      select employer_registration from app.statutory_scheme where id = ${sibling}`;
    expect(row!.employer_registration).toBeNull();
    const dto = (await (
      await f.api.request({ method: "GET", path: path(), as: f.officer })
    ).json()) as Dto;
    expect(dto.payDay).not.toBe(7);
  });

  it("a principal without admin.company.manage is refused on both verbs (§3.6.2)", async () => {
    expect((await f.api.request({ method: "GET", path: path(), as: f.outsider })).status).toBe(403);
    const put = await f.api.request({
      method: "PUT",
      path: path(),
      as: f.outsider,
      body: { prorationRule: "calendar_days", payDay: 1 },
    });
    expect(put.status).toBe(403);
  });

  it("another tenant's company is refused before any row is read (test 12)", async () => {
    const other = await seedTenantV2(f.db, "hr-settings-other");
    await withTenant(
      f.db.rw,
      other.tenant,
      other.system,
      (tx) => tx`insert into app.company_hr_setting (tenant_id, company_id, pay_day)
                 values (${other.tenant}, ${other.company}, 9)`,
    );
    const res = await f.api.request({
      method: "GET",
      path: `/v1/companies/${other.company}/hr-settings`,
      as: f.officer,
    });
    expect(res.status).toBe(403);
  });

  it("PUT without Idempotency-Key is refused like every other unsafe route", async () => {
    const res = await f.api.request({
      method: "PUT",
      path: path(),
      as: f.officer,
      body: { prorationRule: "calendar_days", payDay: 1 },
      idempotencyKey: null,
    });
    expect((await problemOf(res)).code).toBe("ERR_IDEMPOTENCY_KEY_MISSING");
  });
});
