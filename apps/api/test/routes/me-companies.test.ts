import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MyCompaniesSchema } from "@dulja/contracts/admin/my-companies";
import { grantCodes, seedBranch, seedTenant, uuidv7, withTenant, type Seed } from "@dulja/db/test";
import { startApi, type StartedApi } from "../support/app";

/**
 * UI-03 / UI-11 (2026-11-15 review; ADR 0089): the back office resolves its company, and a report's branch choices,
 * from a membership-scoped lookup — not `GET /v1/companies` (gated `admin.company.manage`, which the seeded
 * `accountant` and `auditor` lack) nor `/v1/staff-context` (seven staff codes only).
 */
describe("GET /v1/me/companies — the caller's own companies and branches", () => {
  let api: StartedApi;
  let a: Seed;
  let b: Seed;
  let aBranch2: string;
  let archived: string;
  const list = async (as?: string) => {
    const response = await api.request({
      method: "GET",
      path: "/v1/me/companies",
      ...(as ? { as } : {}),
    });
    return response;
  };
  const companiesOf = async (as: string) => {
    const response = await list(as);
    expect(response.status).toBe(200);
    return MyCompaniesSchema.parse(await response.json()).companies;
  };
  /** A second company in a seed's tenant, with its own BRANCH dimension and one branch. */
  const secondCompany = async (s: Seed, code: string) => {
    const company = await uuidv7(api.db.admin);
    const type = await uuidv7(api.db.admin);
    const branch = await uuidv7(api.db.admin);
    await withTenant(api.db.migrator, s.tenant, s.system, async (tx) => {
      await tx`insert into app.company(id,tenant_id,code,name,base_currency)
        values(${company},${s.tenant},${code},${`${code} company`},'MYR')`;
      await tx`insert into app.dimension_type(id,tenant_id,company_id,code,name_en)
        values(${type},${s.tenant},${company},'BRANCH','Branch')`;
      await tx`insert into app.dimension_value(id,tenant_id,dimension_type_id,code,name_en)
        values(${branch},${s.tenant},${type},${`${code}-B`},${`${code} branch`})`;
    });
    return { company, branch };
  };
  const assign = async (s: Seed, principal: string, company: string, codes: string[]) => {
    const role = await uuidv7(api.db.admin);
    await withTenant(api.db.migrator, s.tenant, s.system, async (tx) => {
      await tx`insert into app.role(id,tenant_id,code,name_en) values(${role},${s.tenant},${`r-${role.slice(-12)}`},'Role')`;
      for (const code of codes)
        await tx`insert into app.role_permission(tenant_id,role_id,permission_code) values(${s.tenant},${role},${code})`;
      await tx`insert into app.role_assignment(tenant_id,principal_id,role_id,company_id)
        values(${s.tenant},${principal},${role},${company})`;
    });
    return role;
  };
  const newHuman = async (s: Seed, name: string) => {
    const id = await uuidv7(api.db.admin);
    await withTenant(api.db.migrator, s.tenant, s.system, async (tx) => {
      await tx`insert into app.principal(id,kind,auth_subject,display_name) values(${id},'human',${`human:${id}`},${name})`;
      await tx`insert into app.membership(tenant_id,principal_id) values(${s.tenant},${id})`;
    });
    return id;
  };

  beforeAll(async () => {
    api = await startApi();
    a = await seedTenant(api.db, "Me alpha");
    b = await seedTenant(api.db, "Me bravo");
    aBranch2 = await seedBranch(api.db, a, { code: "BR2" });
    archived = await seedBranch(api.db, a, { code: "OLD" });
    await withTenant(api.db.migrator, a.tenant, a.system, async (tx) => {
      await tx`update app.dimension_value set archived_at=now() where id=${archived}`;
      // A non-BRANCH dimension value is never offered as a branch.
      const dept = await uuidv7(api.db.admin);
      await tx`insert into app.dimension_type(id,tenant_id,company_id,code,name_en)
        values(${dept},${a.tenant},${a.company},'DEPARTMENT','Department')`;
      await tx`insert into app.dimension_value(id,tenant_id,dimension_type_id,code,name_en)
        values(${await uuidv7(api.db.admin)},${a.tenant},${dept},'DEPT','Dept')`;
    });
    // The seeded accountant's shape: report and tax codes, no admin.company.manage.
    await grantCodes(api.db, a, { codes: ["accounting.report.read", "accounting.ledger.read"] });
    await grantCodes(api.db, b, { codes: ["accounting.report.read"] });
  });
  afterAll(async () => api.stop());

  it("answers an accountant without admin.company.manage: the company, its live branches, ids/codes/names only", async () => {
    expect((await api.request({ method: "GET", path: "/v1/companies", as: a.human })).status).toBe(
      403,
    );
    const companies = await companiesOf(a.human);
    expect(companies).toEqual([
      {
        id: a.company,
        code: "HQ",
        name: "Me alpha HQ",
        branches: [
          { id: aBranch2, code: "BR2", nameEn: "Second branch", nameAr: null },
          { id: a.hq, code: "HQ", nameEn: "Head office", nameAr: null },
        ],
      },
    ]);
  });

  it("two tenants: each caller sees only its own tenant's company", async () => {
    const alpha = JSON.stringify(await companiesOf(a.human));
    const bravo = await companiesOf(b.human);
    expect(bravo.map((c) => c.id)).toEqual([b.company]);
    expect(alpha).not.toContain(b.company);
    expect(alpha).not.toContain(b.hq);
    expect(JSON.stringify(bravo)).not.toContain(a.company);
  });

  it("two companies in one tenant: only a company the caller holds a live role in is listed", async () => {
    const other = await secondCompany(a, "OTHER");
    const human = await newHuman(a, "Two-company clerk");
    await assign(a, human, a.company, ["accounting.report.read"]);
    expect((await companiesOf(human)).map((c) => c.id)).toEqual([a.company]);
    expect(JSON.stringify(await companiesOf(human))).not.toContain(other.branch);
    const role = await assign(a, human, other.company, ["inventory.stock.read"]);
    const both = await companiesOf(human);
    expect(both.map((c) => c.id).toSorted()).toEqual([a.company, other.company].toSorted());
    expect(both.find((c) => c.id === other.company)?.branches.map((x) => x.id)).toEqual([
      other.branch,
    ]);
    // An expired assignment is not a live role.
    await withTenant(api.db.migrator, a.tenant, a.system, async (tx) => {
      await tx`update app.role_assignment set expires_at=now()-interval '1 second'
        where principal_id=${human} and role_id=${role} and company_id=${other.company}`;
    });
    expect((await companiesOf(human)).map((c) => c.id)).toEqual([a.company]);
  });

  it("a branch-restricted role lists only its own branches; a company-wide one in the same company widens to all", async () => {
    const human = await newHuman(a, "Branch clerk");
    await grantCodes(api.db, a, {
      principalId: human,
      codes: ["inventory.stock.read"],
      branchIds: [a.hq],
    });
    const [only] = await companiesOf(human);
    expect(only?.branches.map((x) => x.id)).toEqual([a.hq]);
    await grantCodes(api.db, a, { principalId: human, codes: ["accounting.report.read"] });
    const [wide] = await companiesOf(human);
    expect(wide?.branches.map((x) => x.id)).toEqual([aBranch2, a.hq]);
  });

  it("grants nothing: a member with no role gets an empty list, and anonymous callers 401", async () => {
    const human = await newHuman(a, "No role");
    expect(await companiesOf(human)).toEqual([]);
    expect((await list()).status).toBe(401);
  });
});
