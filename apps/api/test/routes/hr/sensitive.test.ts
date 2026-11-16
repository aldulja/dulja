import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PERMISSION } from "@dulja/contracts/permissions";
import { grantCodes, uuidv7, withTenant } from "@dulja/db/test";
import { startApi } from "../../support/app";
import { problemOf } from "../../../../../tests/support/api"; // 0B's, imported directly
import { hrFixture, type HrFixture } from "../../../../../tests/invariants/support/hr";

/** The same expression `hrFixture` uses for `sixC`, repeated at module level because `it.skipIf` is evaluated at
 *  COLLECTION time, before `beforeAll` has assigned `f`. On this branch 6C has merged, so both directory cases run. */
const SIX_C = "hr.employee.read" in PERMISSION;

describe("GET|PUT /v1/companies/{companyId}/employees/{employeeId}/sensitive — test 32, the endpoint half", () => {
  let f: HrFixture;
  let target: string;
  let writerOnly: string;
  const path = (employeeId: string) =>
    `/v1/companies/${f.companyId}/employees/${employeeId}/sensitive`;

  beforeAll(async () => {
    f = await hrFixture(await startApi(), "hr-sensitive");
    target = f.employees[0]!.id;
    // A principal holding the WRITE gate and not the confidentiality gate. The fixture has no such principal by
    // design; this suite needs one to prove the two-code arrangement is enforced at both layers. Minted through
    // the migrator as the system principal, the tree's fixture pattern (progress log, T3).
    writerOnly = await uuidv7(f.db.admin);
    await withTenant(f.db.migrator, f.seed.tenant, f.seed.system, async (tx) => {
      await tx`insert into app.principal (id, auth_subject, kind, display_name)
               values (${writerOnly}, ${`sub-${writerOnly}`}, 'human', 'Writer only')`;
      await tx`insert into app.membership (tenant_id, principal_id) values (${f.seed.tenant}, ${writerOnly})`;
    });
    await grantCodes(f.db, f.seed, {
      codes: ["hr.compensation.manage", ...(SIX_C ? ["hr.employee.read"] : [])],
      principalId: writerOnly,
      roleCode: "hr-writer-only",
    });
    await f.api.loadPrincipals();
  }, 240_000);
  afterAll(async () => {
    await f.api.stop();
  });

  it("the holder writes and reads back", async () => {
    const put = await f.api.request({
      method: "PUT",
      path: path(target),
      as: f.officer,
      body: {
        nationalId: "SYNTHETIC-ID-0001",
        bankAccount: "SYNTHETIC-ACC-9",
        epfNumber: "SYNTHETIC-EPF-7",
      },
    });
    expect(put.status).toBe(200);
    const get = await f.api.request({ method: "GET", path: path(target), as: f.officer });
    expect(get.status).toBe(200);
    const dto = (await get.json()) as {
      nationalId: string | null;
      bankAccount: string | null;
      passport: string | null;
      keyVersion: number;
      updatedBy: string;
    };
    expect(dto.nationalId).toBe("SYNTHETIC-ID-0001");
    expect(dto.bankAccount).toBe("SYNTHETIC-ACC-9");
    expect(dto.passport).toBeNull();
    expect(dto.keyVersion).toBe(1);
    expect(dto.updatedBy).toBe(f.officer);
  });

  it("a principal with hr.employee.read but not read_sensitive is refused, not given nulls", async () => {
    const res = await f.api.request({ method: "GET", path: path(target), as: f.outsider });
    expect(res.status).toBe(403);
    expect((await problemOf(res)).code).toBe("ERR_RBAC_FORBIDDEN");
  });

  it("the same principal writing is refused", async () => {
    const res = await f.api.request({
      method: "PUT",
      path: path(target),
      as: f.outsider,
      body: { nationalId: "SHOULD-NOT-LAND" },
    });
    expect(res.status).toBe(403);
    // The outsider holds neither code, so the MIDDLEWARE refuses first, on the manage code.
    expect((await problemOf(res)).code).toBe("ERR_RBAC_FORBIDDEN");
  });

  it("the WRITE needs BOTH codes: hr.compensation.manage passes the gate, sensitive_gate stops the row", async () => {
    const res = await f.api.request({
      method: "PUT",
      path: path(target),
      as: writerOnly,
      body: { nationalId: "SHOULD-NOT-LAND-EITHER" },
    });
    expect(res.status).toBe(403);
    expect((await problemOf(res)).code).toBe("ERR_RLS_DENIED");
    // and nothing landed: the holder still reads what the first case wrote
    const get = await f.api.request({ method: "GET", path: path(target), as: f.officer });
    expect(((await get.json()) as { nationalId: string }).nationalId).toBe("SYNTHETIC-ID-0001");
  });

  it("the same principal READING is refused by the middleware, on the read code", async () => {
    const res = await f.api.request({ method: "GET", path: path(target), as: writerOnly });
    expect(res.status).toBe(403);
    expect((await problemOf(res)).code).toBe("ERR_RBAC_FORBIDDEN");
  });

  it.skipIf(!SIX_C)(
    "the employee DIRECTORY carries no sensitive field for anyone, holder included",
    async () => {
      for (const who of [f.officer, f.outsider]) {
        for (const p of [
          `/v1/companies/${f.companyId}/employees?limit=50`,
          `/v1/companies/${f.companyId}/employees/${target}`,
        ]) {
          const res = await f.api.request({ method: "GET", path: p, as: who });
          expect(res.status).toBe(200);
          const text = await res.text();
          for (const needle of [
            "nationalId",
            "passport",
            "bankAccount",
            "epfNumber",
            "socsoNumber",
            "taxNumber",
            "dateOfBirth",
            "residencyCategory",
            "workPermitExpiry",
          ]) {
            expect(text).not.toContain(needle);
          }
          expect(text).not.toContain("SYNTHETIC-ID-0001");
        }
      }
    },
  );

  it.skipIf(!SIX_C)(
    "a sensitive field cannot be used as a filter or a sort — it is not a declared field (§4.2.8)",
    async () => {
      for (const q of [
        "filter[nationalId][eq]=SYNTHETIC-ID-0001",
        "filter[bankAccount][like]=SYNTH",
        "sort=nationalId",
        "sort=-bankAccount",
        "fields=nationalId",
      ]) {
        const res = await f.api.request({
          method: "GET",
          path: `/v1/companies/${f.companyId}/employees?${q}`,
          as: f.officer,
        });
        expect(res.status).toBe(400);
        expect((await problemOf(res)).code).toBe("ERR_VALIDATION_FAILED");
      }
    },
  );

  it("a stray key in the body is refused, not silently dropped", async () => {
    const res = await f.api.request({
      method: "PUT",
      path: path(target),
      as: f.officer,
      body: { keyVersion: 7 },
    });
    expect(res.status).toBe(400);
    expect((await problemOf(res)).code).toBe("ERR_VALIDATION_FAILED");
  });

  it("R4: the officer cannot write their OWN sensitive row (spec:2175, test 31's R4 clause)", async () => {
    const self = f.employees.find((e) => e.principalId === f.officer)!;
    const res = await f.api.request({
      method: "PUT",
      path: path(self.id),
      as: f.officer,
      body: { nationalId: "SYNTHETIC-ID-SELF" },
    });
    expect(res.status).toBe(409);
    expect((await problemOf(res)).code).toBe("ERR_HR_SELF_PAY");
  });

  it("an unsafe call with no Idempotency-Key is refused like every other unsafe route", async () => {
    const res = await f.api.request({
      method: "PUT",
      path: path(target),
      as: f.officer,
      body: { passport: "SYNTHETIC-PP-1" },
      idempotencyKey: null,
    });
    expect((await problemOf(res)).code).toBe("ERR_IDEMPOTENCY_KEY_MISSING");
  });

  it("an employee of another tenant is 404, never 403 (no cross-tenant existence leak)", async () => {
    const res = await f.api.request({
      method: "GET",
      path: path("00000000-0000-7000-8000-0000000000ff"),
      as: f.officer,
    });
    expect(res.status).toBe(404);
  });

  it("an employee of another COMPANY of the same tenant is 404 on both verbs — the path company binds", async () => {
    // A sibling company in which the officer ALSO holds every 8A code: the gate clears at the path company, and
    // only the handler's company binding stops the target (an employee of the first company) from answering.
    // Without it the GET would answer 200, because sensitive_gate asks the code at the EMPLOYEE's company.
    const sibling = await withTenant(f.db.migrator, f.seed.tenant, f.seed.system, async (tx) => {
      const [company] = await tx<{ id: string }[]>`
        insert into app.company (tenant_id, code, name, base_currency)
        values (${f.seed.tenant}, 'HR-SIBLING', 'Sibling company', 'MYR') returning id`;
      await tx`insert into app.role_assignment (tenant_id, principal_id, role_id, company_id)
               select ${f.seed.tenant}, ${f.officer}, r.id, ${company!.id}
                 from app.role r where r.tenant_id = ${f.seed.tenant} and r.code = 'hr-officer'`;
      return company!.id;
    });
    await f.api.loadPrincipals();
    for (const method of ["GET", "PUT"] as const) {
      const res = await f.api.request({
        method,
        path: `/v1/companies/${sibling}/employees/${target}/sensitive`,
        as: f.officer,
        ...(method === "PUT" ? { body: { passport: "SYNTHETIC-PP-X" } } : {}),
      });
      expect(res.status).toBe(404);
      expect((await problemOf(res)).code).toBe("ERR_NOT_FOUND");
    }
  });
});
