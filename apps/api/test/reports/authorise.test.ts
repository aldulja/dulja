import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Context } from "hono";
import type { Sql } from "postgres";
import { grantCodes, seedTenantV2, type Seed } from "@dulja/db/test";
import { withTenant } from "@dulja/db";
import { AppError } from "@dulja/contracts";
import { requireReportExport } from "../../src/reports/authorise";
import { startApi, type StartedApi } from "../support/app";
import type { AppEnv } from "../../src/context";

let api: StartedApi;
let holder: Seed;
let bare: Seed;
let otherCompanyHolder: Seed;

/** The one member `requireReportExport` touches — §4.2.3's `withTenant` variable — and nothing else. */
function contextFor(s: Seed): Context<AppEnv> {
  return {
    var: {
      withTenant: <T>(fn: (tx: Sql) => Promise<T>) =>
        withTenant(
          api.db.rw,
          { tenantId: s.tenant, actorId: s.human, requestId: crypto.randomUUID() },
          fn,
        ),
    },
  } as unknown as Context<AppEnv>;
}

beforeAll(async () => {
  api = await startApi();
  holder = await seedTenantV2(api.db, "authorise-holder");
  bare = await seedTenantV2(api.db, "authorise-bare");
  otherCompanyHolder = await seedTenantV2(api.db, "authorise-other");
  await grantCodes(api.db, holder, { codes: ["accounting.report.export"] });
  await grantCodes(api.db, otherCompanyHolder, { codes: ["accounting.report.export"] });
});
afterAll(async () => {
  await api.stop();
});

describe("requireReportExport — §3.6.3's PERMISSION[…] reference and the gate it evaluates", () => {
  it("allows a principal holding accounting.report.export in the company", async () => {
    await expect(requireReportExport(contextFor(holder), holder.company)).resolves.toBeUndefined();
  });

  it("refuses a principal without it, naming the code and the company (spec:2051)", async () => {
    const refusal = await requireReportExport(contextFor(bare), bare.company).then(
      () => null,
      (e: unknown) => e,
    );
    expect(refusal).toBeInstanceOf(AppError);
    expect((refusal as AppError).code).toBe("ERR_RBAC_FORBIDDEN");
    expect((refusal as AppError).message).toContain("accounting.report.export");
    expect((refusal as AppError).message).toContain(bare.company);
  });

  it("is bound to the named company: a grant in another tenant's company does not carry over", async () => {
    await expect(
      requireReportExport(contextFor(otherCompanyHolder), holder.company),
    ).rejects.toMatchObject({ code: "ERR_RBAC_FORBIDDEN" });
  });
});
