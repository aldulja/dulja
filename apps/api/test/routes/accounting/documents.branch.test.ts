import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedDocumentType, seedTenantV2, uuidv7, type Seed } from "@dulja/db/test";
import { grantAdmin, problemOf } from "../../../../../tests/support/api";
import { startApi, type StartedApi } from "../../support/app";

describe("spec:1066 through the API — a policy that requires BRANCH refuses a line without it", () => {
  let api: StartedApi;
  let a: Seed;

  /** `grantAdmin` grants the five admin codes and nothing else. The document routes gate on the code the
   *  policy names (`accounting.journal.post` here, 2A Task 9) and the read on journal.create | journal.post |
   *  ledger.read, so the two are granted through a real role chain rather than assumed. */
  const grantCodes = async (s: Seed, principalId: string, ...codes: string[]): Promise<void> => {
    const roleId = await uuidv7(api.db.admin);
    await api.db.migrator.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${s.tenant}, true), set_config('app.actor_id', ${s.system}, true)`;
      await tx`insert into app.role (id, tenant_id, code, name_en)
               values (${roleId}, ${s.tenant}, ${`r-${roleId.slice(-12)}`}, 'grant')`;
      for (const code of codes) {
        await tx`insert into app.role_permission (tenant_id, role_id, permission_code) values (${s.tenant}, ${roleId}, ${code})`;
      }
      await tx`insert into app.role_assignment (tenant_id, principal_id, role_id, company_id)
               values (${s.tenant}, ${principalId}, ${roleId}, ${s.company})`;
    });
  };

  beforeAll(async () => {
    api = await startApi();
    a = await seedTenantV2(api.db, "Alpha");
    await grantAdmin(api, a);
    await grantCodes(a, a.human, "accounting.journal.post", "accounting.ledger.read");
    await seedDocumentType(api.db, a, {
      code: "POLICY_TEST",
      policy: {
        version: 1,
        documentType: "POLICY_TEST",
        direction: "internal",
        requires: [],
        lines: [
          {
            for: "each_line",
            side: "debit",
            account: { code: "1000" },
            amount: "line.debit",
            dimensions: { from: ["line.dimensions"] },
          },
          {
            for: "each_line",
            side: "credit",
            account: { code: "4000" },
            amount: "line.credit",
            dimensions: { from: ["line.dimensions"] },
          },
        ],
        inventory: { effect: "none" },
        tax: { applies: false },
        numbering: { series: "PT", assignAt: "issue" },
        reversal: { allowed: true, producesType: "POLICY_TEST" },
        approval: { required: false, approve: null, post: "accounting.journal.post" },
        fxRoundingAccount: { from: "company.fx_rounding_account_id" },
        dimensions: { required: ["BRANCH"] },
      },
    });
  });
  afterAll(async () => {
    await api.stop();
  });

  it("the post is 422 ERR_POLICY_REQUIRES_MISSING and the document stays unposted", async () => {
    const created = await api.request({
      method: "POST",
      path: `/v1/companies/${a.company}/documents`,
      as: a.human,
      body: {
        documentTypeCode: "POLICY_TEST",
        effectiveDate: "2026-01-15",
        currency: "MYR",
        branchId: a.hq,
        lines: [
          { lineNo: 1, kind: "account", accountId: a.cash, debit: "9.0000" },
          { lineNo: 2, kind: "account", accountId: a.sales, credit: "9.0000" },
        ],
      },
    });
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };
    const res = await api.request({
      method: "POST",
      path: `/v1/companies/${a.company}/documents/${id}/transitions`,
      as: a.human,
      body: { to: "posted" },
    });
    const problem = await problemOf(res);
    expect(problem.status).toBe(422);
    expect(problem.code).toBe("ERR_POLICY_REQUIRES_MISSING");
    expect(problem.detail).toMatch(/BRANCH/);
    const read = await api.request({
      method: "GET",
      path: `/v1/companies/${a.company}/documents/${id}`,
      as: a.human,
    });
    expect(((await read.json()) as { status: string }).status).toBe("draft");
  });
});
