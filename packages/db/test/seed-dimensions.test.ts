import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "../src/client";
import { seed } from "../src/seed";
import { StubSeedAuthAdmin } from "../src/seed/auth-admin";
import { parseSeedArgs } from "../src/seed/config";
import { startDb, type Db } from "./harness";

describe("the dimensions loader — BRANCH and head office (spec:2000)", () => {
  let db: Db;
  let migrator: ReturnType<typeof createDb>;
  const tenantId = randomUUID();
  let companyId = "";
  const args = (...only: string[]) =>
    parseSeedArgs(
      ["--tenant", tenantId, ...only.flatMap((name) => ["--only", name])],
      {} as NodeJS.ProcessEnv,
    );

  beforeAll(async () => {
    db = await startDb();
    migrator = createDb(db.url("app_migrator"));
    ({ companyId } = await seed(migrator, args("dimensions"), new StubSeedAuthAdmin()));
  });
  afterAll(async () => {
    await migrator.end();
    await db.stop();
  });

  it("creates the BRANCH type and its head-office value, bilingual columns and not a blob (spec:2045)", async () => {
    const [t] = await db.admin<{ id: string; name_en: string }[]>`
      select id::text as id, name_en from app.dimension_type where company_id = ${companyId} and code = 'BRANCH'`;
    expect(t!.name_en).toBe("Branch");
    const values = await db.admin<{ code: string; name_en: string }[]>`
      select code, name_en from app.dimension_value where dimension_type_id = ${t!.id} order by code`;
    expect(values).toEqual([{ code: "HQ", name_en: "Head office" }]);
  });

  it("the head-office value is a legal branch for role_assignment_branch and document.branch_id", async () => {
    const [v] = await db.admin<{ id: string; tenant_id: string }[]>`
      select dv.id::text as id, dv.tenant_id::text as tenant_id
        from app.dimension_value dv join app.dimension_type dt on dt.id = dv.dimension_type_id
       where dt.company_id = ${companyId} and dt.code = 'BRANCH' and dv.code = 'HQ'`;
    // Both branch foreign keys are composite (tenant_id, branch_id) → dimension_value(tenant_id, id).
    expect(v!.tenant_id).toBe(tenantId);
    const [fk] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from pg_constraint
       where conname in ('role_assignment_branch_dim_fk', 'document_branch_fk')
         and confrelid = 'app.dimension_value'::regclass`;
    expect(fk!.n).toBe(2);
  });

  it("re-running inserts nothing", async () => {
    const again = await seed(migrator, args("dimensions"), new StubSeedAuthAdmin());
    expect(again.applied.dimensions).toBe(0);
  });
});
