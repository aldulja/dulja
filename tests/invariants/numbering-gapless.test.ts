import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  postDocument,
  runIntegrityCheck,
  systemContext,
  transitionDocument,
  voidDocument,
  withTenant,
  type TenantContext,
} from "@dulja/db";
import {
  grantCodes,
  seedDocumentType,
  seedTenantV2,
  uuidv7,
  withTenant as testWithTenant,
  type Seed,
} from "@dulja/db/test";
import { startApi, type StartedApi } from "../../apps/api/test/support/app";

/** A JOURNAL-shaped policy whose only difference is the series it numbers into. `NG_NG`, `NG_RC` and `NG_HT`
 *  are contracts §4.14's registered test-only codes — three codes because one type names one series. */
const policyFor = (series: string) => ({
  version: 1,
  documentType: `NG_${series}`,
  direction: "internal",
  requires: [],
  lines: [
    {
      for: "each_line",
      side: "debit",
      account: { from: "line.account" },
      amount: "line.debit",
      when: { "line.kind": "account" },
    },
    {
      for: "each_line",
      side: "credit",
      account: { from: "line.account" },
      amount: "line.credit",
      when: { "line.kind": "account" },
    },
  ],
  inventory: { effect: "none" },
  tax: { applies: false },
  numbering: { series, assignAt: "issue" },
  reversal: { allowed: true, producesType: `NG_${series}` },
  approval: { required: false, approve: null, post: "accounting.journal.post" },
  fxRoundingAccount: { from: "company.fx_rounding_account_id" },
  dimensions: { required: [] },
});

const ctx = (s: Seed): TenantContext => ({
  tenantId: s.tenant,
  actorId: s.human,
  requestId: "test16",
});

/**
 * Acceptance test 16 (spec:2434) and the Phase 2 DoD clause "issued numbers are unique and gapless-provable"
 * (spec:2288). LEGACY-051 is the defect: a race on the first document of a new series, no uniqueness constraint,
 * numbers assigned at insert rather than at issue, and no way to demonstrate the sequence is unbroken.
 *
 * The mechanism is spread across three slices and this file is where the sentence becomes a gate:
 *   the advisory lock and the counter — 1A (contracts §4.3.6);
 *   the unique constraint `(company_id, series, fiscal_period_id, number)` — migration 0001;
 *   `app.series_gaps`, the two draft-only DELETE guards and `SERIES_GAP_CHECK` — 2B Task 4.
 */
describe("acceptance test 16 — numbering is unique, gapless-provable and undeletable", () => {
  let api: StartedApi;
  let a: Seed;
  let ngType: string; // numbers into series "NG"
  let ngPeriod: string; // a period of its own, so every counter starts empty

  const draft = async (
    typeId: string,
    series: string,
    periodId: string,
    on: string,
  ): Promise<string> => {
    const id = await uuidv7(api.db.admin);
    await testWithTenant(api.db.rw, a.tenant, a.human, async (tx) => {
      await tx`insert into app.document (id, tenant_id, company_id, document_type_id, series, effective_date, currency, branch_id, fiscal_period_id)
               values (${id}, ${a.tenant}, ${a.company}, ${typeId}, ${series}, ${on}, 'MYR', ${a.hq}, ${periodId})`;
      await tx`insert into app.document_line (tenant_id, company_id, document_id, line_no, account_id, debit)
               values (${a.tenant}, ${a.company}, ${id}, 1, ${a.cash}, 7.0000)`;
      await tx`insert into app.document_line (tenant_id, company_id, document_id, line_no, account_id, credit)
               values (${a.tenant}, ${a.company}, ${id}, 2, ${a.sales}, 7.0000)`;
    });
    return id;
  };

  const gaps = (series: string, periodId: string) =>
    withTenant(
      api.db.rw,
      ctx(a),
      (tx) => tx<{ number: string }[]>`
        select number::text as number from app.series_gaps(${a.company}, ${series}, ${periodId}) order by 1`,
    );

  const counter = (series: string, periodId: string) =>
    withTenant(
      api.db.rw,
      ctx(a),
      (tx) => tx<{ next_number: string }[]>`
        select next_number::text as next_number from app.document_series
         where company_id = ${a.company} and series = ${series} and fiscal_period_id = ${periodId}`,
    );

  beforeAll(async () => {
    api = await startApi();
    a = await seedTenantV2(api.db, "Alpha");
    await grantCodes(api.db, a, { codes: ["accounting.journal.post"] });
    ngPeriod = await uuidv7(api.db.admin);
    await testWithTenant(
      api.db.migrator,
      a.tenant,
      a.system,
      (tx) => tx`
        insert into app.fiscal_period (id, tenant_id, company_id, starts_on, ends_on, status)
        values (${ngPeriod}, ${a.tenant}, ${a.company}, '2029-01-01', '2029-01-31', 'open')`,
    );
    ngType = await seedDocumentType(api.db, a, {
      code: "NG_NG",
      policy: policyFor("NG"),
      effectiveFrom: "2026-01-01",
    });
  });
  afterAll(async () => {
    await api.stop();
  });

  it("clause 1 — two connections racing the FIRST document of a new series both succeed, with 1 and 2", async () => {
    const raceType = await seedDocumentType(api.db, a, {
      code: "NG_RC",
      policy: policyFor("RC"),
      effectiveFrom: "2026-01-01",
    });
    const left = await draft(raceType, "RC", ngPeriod, "2029-01-10");
    const right = await draft(raceType, "RC", ngPeriod, "2029-01-10");
    expect(await counter("RC", ngPeriod)).toEqual([]); // the counter row does not exist yet — LEGACY-051

    // Two real connections, max: 1 each — the interleaving spec:2266 asks for, not two promises on one pool.
    const one = postgres(api.db.url("app_rw"), { max: 1, prepare: false });
    const two = postgres(api.db.url("app_rw"), { max: 1, prepare: false });
    try {
      const results = await Promise.all([
        withTenant(one, ctx(a), (tx) =>
          transitionDocument(tx, ctx(a), { documentId: left, to: "issued" }),
        ),
        withTenant(two, ctx(a), (tx) =>
          transitionDocument(tx, ctx(a), { documentId: right, to: "issued" }),
        ),
      ]);
      expect(results.map((r) => r.number).toSorted()).toEqual([1n, 2n]);
    } finally {
      await one.end();
      await two.end();
    }
    expect(await gaps("RC", ngPeriod)).toEqual([]);
  });

  it("clause 1 through the HTTP surface — two concurrent transitions on one API instance", async () => {
    const httpType = await seedDocumentType(api.db, a, {
      code: "NG_HT",
      policy: policyFor("HT"),
      effectiveFrom: "2026-01-01",
    });
    const left = await draft(httpType, "HT", ngPeriod, "2029-01-11");
    const right = await draft(httpType, "HT", ngPeriod, "2029-01-11");
    const move = (id: string) =>
      api.request({
        method: "POST",
        path: `/v1/companies/${a.company}/documents/${id}/transitions`,
        as: a.human,
        body: { to: "issued" },
      });
    const [l, r] = await Promise.all([move(left), move(right)]);
    expect([l.status, r.status]).toEqual([200, 200]);
    const numbers = await withTenant(
      api.db.rw,
      ctx(a),
      (tx) => tx<{ number: string }[]>`
        select number::text as number from app.document where id in (${left}, ${right}) order by number`,
    );
    expect(numbers.map((n) => n.number)).toEqual(["1", "2"]);
  });

  it("clause 2 — a second document cannot take an issued number, at any privilege level", async () => {
    const first = await draft(ngType, "NG", ngPeriod, "2029-01-12");
    await withTenant(api.db.rw, ctx(a), (tx) =>
      transitionDocument(tx, ctx(a), { documentId: first, to: "issued" }),
    );
    const impostor = await draft(ngType, "NG", ngPeriod, "2029-01-12");
    // app_rw, writing the number by hand — the LEGACY-051 "a client supplying its own number" path.
    await expect(
      testWithTenant(
        api.db.rw,
        a.tenant,
        a.human,
        (tx) => tx`update app.document set number = 1 where id = ${impostor}`,
      ),
    ).rejects.toThrow(/duplicate key value|document_company_id_series_fiscal_period_id_number_key/);
    // and the migrator, which owns the schema and still cannot do it — the constraint is not a privilege
    await expect(
      testWithTenant(
        api.db.migrator,
        a.tenant,
        a.system,
        (tx) => tx`update app.document set number = 1 where id = ${impostor}`,
      ),
    ).rejects.toThrow(/duplicate key value/);
  });

  it("clause 3 — an issued document cannot be deleted through the API, a job, or app_rw SQL (spec:2224)", async () => {
    const doc = await draft(ngType, "NG", ngPeriod, "2029-01-13");
    await withTenant(api.db.rw, ctx(a), (tx) =>
      transitionDocument(tx, ctx(a), { documentId: doc, to: "issued" }),
    );

    // (a) the HTTP route of 2B Task 8
    const res = await api.request({
      method: "DELETE",
      path: `/v1/companies/${a.company}/documents/${doc}`,
      as: a.human,
    });
    expect(res.status).toBe(409);
    expect((await res.json()) as { code: string }).toMatchObject({ code: "ERR_DOC_NOT_DRAFT" });

    // (b) the job path: the tenant's system principal, the context runJob hands every handler (§4.2.6). At 2B
    // no registered handler changes document status, so the context is built with the production
    // systemContext — the same function runJob calls — rather than simulated. actor_has returns true for this
    // principal unconditionally (spec:2179), so the trigger is the only thing standing in its way.
    const sys = await systemContext(api.db.rw, a.tenant, "test16-job");
    await expect(
      withTenant(api.db.rw, sys, (tx) => tx`delete from app.document where id = ${doc}`),
    ).rejects.toThrow(/ERR_DOC_NOT_DRAFT/);

    // (c) direct app_rw SQL, and its lines one row at a time
    await expect(
      withTenant(api.db.rw, ctx(a), (tx) => tx`delete from app.document where id = ${doc}`),
    ).rejects.toThrow(/ERR_DOC_NOT_DRAFT/);
    await expect(
      withTenant(
        api.db.rw,
        ctx(a),
        (tx) => tx`delete from app.document_line where document_id = ${doc} and line_no = 1`,
      ),
    ).rejects.toThrow(/ERR_DOC_NOT_DRAFT/);

    const [alive] = await withTenant(
      api.db.rw,
      ctx(a),
      (tx) => tx<{ n: number }[]>`select count(*)::int as n from app.document where id = ${doc}`,
    );
    expect(alive!.n).toBe(1);
  });

  it("clause 4 — a voided number is recorded, and stays an explained number forever (spec:1745)", async () => {
    const doc = await draft(ngType, "NG", ngPeriod, "2029-01-14");
    const { number } = await withTenant(api.db.rw, ctx(a), (tx) =>
      transitionDocument(tx, ctx(a), { documentId: doc, to: "issued" }),
    );
    await withTenant(api.db.rw, ctx(a), (tx) =>
      voidDocument(tx, ctx(a), { documentId: doc, reason: "printer jam; reissued" }),
    );
    const [recorded] = await withTenant(
      api.db.rw,
      ctx(a),
      (tx) => tx<{ number: string; reason: string }[]>`
        select number::text as number, reason from app.document_number_void
         where company_id = ${a.company} and series = 'NG' and fiscal_period_id = ${ngPeriod}
           and number = ${String(number)}::bigint`,
    );
    expect(recorded).toEqual({ number: String(number), reason: "printer jam; reissued" });
    // The clause "voided numbers are recorded" is the assertion above, not the one below: `voidDocument`
    // updates only `status` and leaves `document.number` in place, so this number is still excluded by
    // series_gaps' document predicate and the line below would read empty with an empty
    // document_number_void. It says the series is still whole, which is worth asserting on its own. That the
    // void RECORD is what series_gaps consults is proved where it can be isolated — the `VOIDONLY` case of
    // packages/db/test/document-delete.test.ts, on a series with no document at all.
    expect(await gaps("NG", ngPeriod)).toEqual([]);
  });

  it("the DoD clause — every counter in the tenant has zero unexplained numbers", async () => {
    const posted = await draft(ngType, "NG", ngPeriod, "2029-01-15");
    await withTenant(api.db.rw, ctx(a), (tx) => postDocument(tx, ctx(a), { documentId: posted }));
    const counters = await withTenant(
      api.db.rw,
      ctx(a),
      (tx) => tx<{ company_id: string; series: string; fiscal_period_id: string }[]>`
        select company_id, series, fiscal_period_id from app.document_series order by series`,
    );
    expect(counters.length).toBeGreaterThan(2); // NG, RC, HT at least — not a vacuous pass
    for (const c of counters) {
      const rows = await withTenant(
        api.db.rw,
        ctx(a),
        (tx) => tx<{ number: string }[]>`
          select number::text as number from app.series_gaps(${c.company_id}, ${c.series}, ${c.fiscal_period_id})`,
      );
      expect(rows, `series ${c.series}`).toEqual([]);
    }
  });

  it("a rolled-back issue leaves no gap, because it consumes no number (spec:1744)", async () => {
    const doomed = await draft(ngType, "NG", ngPeriod, "2029-01-16");
    const before = await counter("NG", ngPeriod);
    await expect(
      withTenant(api.db.rw, ctx(a), async (tx) => {
        await transitionDocument(tx, ctx(a), { documentId: doomed, to: "issued" });
        throw new Error("rolled back on purpose");
      }),
    ).rejects.toThrow(/rolled back on purpose/);
    expect(await counter("NG", ngPeriod)).toEqual(before);
    expect(await gaps("NG", ngPeriod)).toEqual([]);
  });

  it("the proof itself bites: a counter advanced past an unexplained number is reported", async () => {
    // The only way to manufacture an unexplained number is to advance a counter without issuing — the shape a
    // bug in the posting service would produce, which is what the nightly job must catch (2B Task 4).
    const holePeriod = await uuidv7(api.db.admin);
    await testWithTenant(api.db.migrator, a.tenant, a.system, async (tx) => {
      await tx`insert into app.fiscal_period (id, tenant_id, company_id, starts_on, ends_on, status)
               values (${holePeriod}, ${a.tenant}, ${a.company}, '2029-02-01', '2029-02-28', 'open')`;
      await tx`insert into app.document_series (tenant_id, company_id, series, fiscal_period_id, next_number)
               values (${a.tenant}, ${a.company}, 'HOLE', ${holePeriod}, 3)`;
    });
    expect((await gaps("HOLE", holePeriod)).map((r) => r.number)).toEqual(["1", "2"]);

    // and it reaches the nightly integrity run through SERIES_GAP_CHECK, under the job's own principal
    const sys = await systemContext(api.db.rw, a.tenant, "test16-integrity");
    const report = await withTenant(api.db.rw, sys, (tx) => runIntegrityCheck(tx, sys));
    expect(report.projections.checked).toContain("document_series");
    expect(report.projections.mismatches.map((m) => m.key.number)).toContain("1");
    expect(report.ok).toBe(false);
  });
});
