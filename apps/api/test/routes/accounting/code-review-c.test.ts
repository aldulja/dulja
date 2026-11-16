import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { grantCodes, seedTenantV2, withTenant, type Seed } from "@dulja/db/test";
import { problemOf } from "../../../../../tests/support/api";
import { startApi, type StartedApi } from "../../support/app";

const journalBody = (s: Seed, effectiveDate: string) => ({
  documentTypeCode: "JOURNAL",
  effectiveDate,
  currency: "MYR",
  branchId: s.hq,
  lines: [
    { lineNo: 1, accountId: s.cash, debit: "9.0000" },
    { lineNo: 2, accountId: s.sales, credit: "9.0000" },
  ],
});

/**
 * Code review, stream C — finding C5, at the wire. `DateSchema` checked the shape only, so a date-taking
 * route admitted `2026-02-30` and postgres.js rolled it over to 2026-03-02: a reversal could post into a
 * period other than the one requested. `DateSchema` now refines with the one shared `isCalendarDate`, so
 * every route built on it refuses the date with a 400 before any service runs.
 */
describe("C5 — an impossible date is a 400 on every route that takes one", () => {
  let api: StartedApi;
  let a: Seed;

  beforeAll(async () => {
    api = await startApi();
    a = await seedTenantV2(api.db, "Calendar");
    await grantCodes(api.db, a, {
      codes: ["accounting.journal.post", "accounting.document.reverse", "accounting.ledger.read"],
    });
  });
  afterAll(async () => {
    await api.stop();
  });

  it("POST …/reverse refuses effectiveDate 2026-02-30 and the original stays posted", async () => {
    const created = await api.request({
      method: "POST",
      path: `/v1/companies/${a.company}/documents`,
      as: a.human,
      body: journalBody(a, "2026-01-15"),
    });
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };
    const posted = await api.request({
      method: "POST",
      path: `/v1/companies/${a.company}/documents/${id}/transitions`,
      as: a.human,
      body: { to: "posted" },
    });
    expect(posted.status).toBe(200);

    const res = await api.request({
      method: "POST",
      path: `/v1/companies/${a.company}/documents/${id}/reverse`,
      as: a.human,
      body: { effectiveDate: "2026-02-30", reason: "wrong account" },
    });
    expect(res.status).toBe(400);
    const problem = await problemOf(res);
    expect(problem.code).toBe("ERR_VALIDATION_FAILED");
    expect(JSON.stringify(problem)).toContain("must be a calendar date YYYY-MM-DD");

    const rows = await withTenant(
      api.db.rw,
      a.tenant,
      a.human,
      (tx) => tx<{ status: string; n: number }[]>`
        select (select status::text from app.document where id = ${id}) as status,
               (select count(*)::int from app.document where reverses_document_id = ${id}) as n`,
    );
    expect(rows).toEqual([{ status: "posted", n: 0 }]);
  });

  it("POST …/documents refuses a draft dated 2026-02-30 (the same schema, a different route)", async () => {
    const res = await api.request({
      method: "POST",
      path: `/v1/companies/${a.company}/documents`,
      as: a.human,
      body: journalBody(a, "2026-02-30"),
    });
    expect(res.status).toBe(400);
    expect((await problemOf(res)).code).toBe("ERR_VALIDATION_FAILED");
  });
});
