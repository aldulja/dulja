import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { encodeCursor, type Problem } from "@dulja/contracts";
import { withTenant } from "@dulja/db";
import { seedTenantV2, uuidv7, type Db, type Seed } from "@dulja/db/test";
import { postJournal } from "../../../../../tests/invariants/support/post-journal";
import { startApi, type StartedApi } from "../../support/app";

/**
 * Creates a role holding `codes`, assigns it to `principalId` in the seed company, as the system principal.
 *
 * **Why file-local, and why not named `grantCodes`.** §4.1 pins 0B's `grantAdmin()` as "the one way" a
 * route test grants — but that helper lives in `tests/support/api.ts`, and the only `apps/<app>/test/**` →
 * `tests/**` allowance this slice uses (dependency-rule's ESCAPE_ALLOW) reaches
 * `tests/invariants/support/**` only, so it is not importable from here. §4.17 separately reserves the
 * identifier `grantCodes` for 2B with a different signature, so this one carries a different name outright
 * rather than shadowing it. The three inserts run under `s.system` so `forbid_self_grant` is not tripped.
 */
async function grantReportCodes(
  db: Db,
  s: Seed,
  principalId: string,
  roleCode: string,
  codes: string[],
): Promise<void> {
  const roleId = await uuidv7(db.admin);
  await withTenant(
    db.migrator,
    { tenantId: s.tenant, actorId: s.system, requestId: await uuidv7(db.admin) },
    async (tx) => {
      await tx`insert into app.role (id, tenant_id, code, name_en, is_system)
               values (${roleId}, ${s.tenant}, ${roleCode}, ${roleCode}, false)`;
      for (const code of codes) {
        await tx`insert into app.role_permission (tenant_id, role_id, permission_code)
                 values (${s.tenant}, ${roleId}, ${code})`;
      }
      await tx`insert into app.role_assignment (tenant_id, principal_id, role_id, company_id)
               values (${s.tenant}, ${principalId}, ${roleId}, ${s.company})`;
    },
  );
}

describe("GET /v1/companies/{companyId}/reports — the Phase 1 minimal set (spec:2300, §4.16.1)", () => {
  let api: StartedApi;
  let db: Db;
  let a: Seed;
  let reader: string;
  let outsider: string;

  beforeAll(async () => {
    api = await startApi();
    db = api.db;
    a = await seedTenantV2(db, "Alpha");
    reader = a.human;
    outsider = await uuidv7(db.admin);
    await withTenant(
      db.migrator,
      { tenantId: a.tenant, actorId: a.system, requestId: await uuidv7(db.admin) },
      async (tx) => {
        await tx`insert into app.principal (id, kind, auth_subject, display_name)
                 values (${outsider}, 'human', ${`human-2:${a.tenant}`}, 'Outsider')`;
        await tx`insert into app.membership (tenant_id, principal_id) values (${a.tenant}, ${outsider})`;
      },
    );
    await grantReportCodes(db, a, reader, "phase1b_reader", [
      "accounting.report.read",
      "accounting.ledger.read",
    ]);
    await grantReportCodes(db, a, outsider, "phase1b_nothing", []);

    await postJournal(
      db,
      a,
      [
        { account: a.cash, debit: "100.0000" },
        { account: a.sales, credit: "100.0000" },
      ],
      { effectiveDate: "2026-01-05" },
    );
    await postJournal(
      db,
      a,
      [
        { account: a.cash, debit: "25.0000" },
        { account: a.sales, credit: "25.0000" },
      ],
      { effectiveDate: "2026-01-12" },
    );
    await postJournal(
      db,
      a,
      [
        { account: a.sales, debit: "10.0000" },
        { account: a.cash, credit: "10.0000" },
      ],
      { effectiveDate: "2026-01-20" },
    );
  });
  afterAll(async () => {
    await api.stop();
  });

  const tb = (query: string, as = reader) =>
    api.request({
      method: "GET",
      path: `/v1/companies/${a.company}/reports/accounting.trial_balance?${query}`,
      as,
    });
  const ledger = (query: string, as = reader) =>
    api.request({
      method: "GET",
      path: `/v1/companies/${a.company}/reports/accounting.ledger?${query}`,
      as,
    });

  it("the trial balance ties to the ledger: Σdebit = Σcredit and every row matches a fresh recomputation", async () => {
    const res = await tb(`fiscalPeriodId=${a.period}&limit=1000`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: { accountCode: string; debit: { amount: string }; credit: { amount: string } }[];
      next_cursor: string | null;
    };

    const recomputed = await withTenant(
      db.rw,
      { tenantId: a.tenant, actorId: reader, requestId: await uuidv7(db.admin) },
      (tx) => tx<{ code: string; debit: string; credit: string }[]>`
        select a.code, sum(l.debit)::text as debit, sum(l.credit)::text as credit
          from app.ledger_entry l join app.account a on a.id = l.account_id
         where l.company_id = ${a.company} and l.fiscal_period_id = ${a.period}
         group by a.code order by a.code`,
    );

    expect(
      body.items.map((row) => ({
        code: row.accountCode,
        debit: row.debit.amount,
        credit: row.credit.amount,
      })),
    ).toEqual(recomputed.map((row) => ({ code: row.code, debit: row.debit, credit: row.credit })));

    const sum = (
      pick: (row: { debit: { amount: string }; credit: { amount: string } }) => string,
    ) => body.items.reduce((acc, row) => acc + BigInt(pick(row).replace(".", "")), 0n);
    expect(sum((row) => row.debit.amount)).toBe(sum((row) => row.credit.amount));
  });

  it("keyset pages concatenate to the single-page result", async () => {
    const one = (await (await tb(`fiscalPeriodId=${a.period}&limit=1000`)).json()) as {
      items: { accountCode: string }[];
    };
    const first = (await (await tb(`fiscalPeriodId=${a.period}&limit=1`)).json()) as {
      items: { accountCode: string }[];
      next_cursor: string;
    };
    const second = (await (
      await tb(`fiscalPeriodId=${a.period}&limit=1&cursor=${first.next_cursor}`)
    ).json()) as { items: { accountCode: string }[] };
    expect([...first.items, ...second.items].map((row) => row.accountCode)).toEqual(
      one.items.map((row) => row.accountCode),
    );
  });

  it("the ledger report's closing running balance equals account_balance for the account", async () => {
    const res = await ledger(
      `accountId=${a.cash}&fromDate=2026-01-01&toDate=2026-01-31&limit=1000`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: { runningBaseBalance: { amount: string } }[];
      opening_base_balance: { amount: string };
    };
    expect(body.opening_base_balance.amount).toBe("0.0000");

    const [row] = await withTenant(
      db.rw,
      { tenantId: a.tenant, actorId: reader, requestId: await uuidv7(db.admin) },
      (tx) => tx<{ balance: string }[]>`
        select (base_debit - base_credit)::numeric(19,4)::text as balance
          from app.account_balance
         where company_id = ${a.company} and account_id = ${a.cash}
           and fiscal_period_id = ${a.period} and currency = 'MYR'`,
    );
    expect(body.items.at(-1)!.runningBaseBalance.amount).toBe(row!.balance);
  });

  it("the ledger's rows are ordered by (effective_date, posting_seq, line_no) and carry the document identity", async () => {
    const body = (await (
      await ledger(`accountId=${a.cash}&fromDate=2026-01-01&toDate=2026-01-31&limit=1000`)
    ).json()) as {
      items: {
        effectiveDate: string;
        postingSeq: string;
        documentTypeCode: string;
        series: string;
      }[];
    };
    const dates = body.items.map((row) => row.effectiveDate);
    expect(dates).toEqual(dates.toSorted());
    expect(new Set(body.items.map((row) => row.documentTypeCode))).toEqual(new Set(["JOURNAL"]));
    expect(new Set(body.items.map((row) => row.series))).toEqual(new Set(["JV"]));
  });

  it("opening_base_balance is the balance brought forward and is identical on every page of a range", async () => {
    // Not the previous page's closing figure: a view that prints "Opening balance" as a header must show
    // one number for the whole range, and the running balance is already on every row (§4.16.3).
    const whole = (await (
      await ledger(`accountId=${a.cash}&fromDate=2026-01-10&toDate=2026-01-31&limit=1000`)
    ).json()) as { opening_base_balance: { amount: string } };
    const first = (await (
      await ledger(`accountId=${a.cash}&fromDate=2026-01-10&toDate=2026-01-31&limit=1`)
    ).json()) as { opening_base_balance: { amount: string }; next_cursor: string };
    const second = (await (
      await ledger(
        `accountId=${a.cash}&fromDate=2026-01-10&toDate=2026-01-31&limit=1&cursor=${first.next_cursor}`,
      )
    ).json()) as {
      opening_base_balance: { amount: string };
      items: { runningBaseBalance: { amount: string } }[];
    };

    // 2026-01-05 posted 100.0000 to cash and is strictly before fromDate, so it is the brought-forward figure.
    expect(whole.opening_base_balance.amount).toBe("100.0000");
    expect(first.opening_base_balance.amount).toBe(whole.opening_base_balance.amount);
    expect(second.opening_base_balance.amount).toBe(whole.opening_base_balance.amount);
    // Page 2 still continues the running sum: the cursor carries only the key, and the seed is
    // recomputed from the ledger up to that key.
    expect(second.items[0]!.runningBaseBalance.amount).toBe("115.0000");
  });

  it("a principal without accounting.report.read is refused", async () => {
    const res = await tb(`fiscalPeriodId=${a.period}`, outsider);
    expect(res.status).toBe(403);
    expect(((await res.json()) as Problem).code).toBe("ERR_RBAC_FORBIDDEN");
  });

  it("the ledger report needs accounting.ledger.read as well as accounting.report.read", async () => {
    const reportOnly = await uuidv7(db.admin);
    await withTenant(
      db.migrator,
      { tenantId: a.tenant, actorId: a.system, requestId: await uuidv7(db.admin) },
      async (tx) => {
        await tx`insert into app.principal (id, kind, auth_subject, display_name)
                 values (${reportOnly}, 'human', ${`human-3:${a.tenant}`}, 'Reports only')`;
        await tx`insert into app.membership (tenant_id, principal_id) values (${a.tenant}, ${reportOnly})`;
      },
    );
    await grantReportCodes(db, a, reportOnly, "phase1b_reports_only", ["accounting.report.read"]);
    expect((await tb(`fiscalPeriodId=${a.period}`, reportOnly)).status).toBe(200);
    const res = await ledger(
      `accountId=${a.cash}&fromDate=2026-01-01&toDate=2026-01-31`,
      reportOnly,
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as Problem).code).toBe("ERR_RBAC_FORBIDDEN");
  });

  it("an undeclared query field is a validation failure, and no field name reaches SQL as text (test 27)", async () => {
    const res = await tb(`fiscalPeriodId=${a.period}&filter[account_code][like]=1%27%3B--`);
    const body = (await res.json()) as Problem;
    expect(res.status).toBe(400);
    expect(body.code).toBe("ERR_VALIDATION_FAILED");
  });

  it("a malformed cursor is a validation failure, never a 500", async () => {
    const res = await tb(`fiscalPeriodId=${a.period}&cursor=not-base64url-json`);
    expect(res.status).toBe(400);
    expect(((await res.json()) as Problem).code).toBe("ERR_VALIDATION_FAILED");
  });

  it("a well-formed cursor whose keyset is not this report's is refused, and a tampered balance cannot be smuggled in", async () => {
    // The ledger cursor is the three-column chronological key and nothing else. A fourth member — what an
    // earlier draft used to carry the running balance — is refused outright rather than cast to numeric.
    const smuggled = encodeCursor({ k: ["2026-01-12", "1", 1, "999999.0000"], id: a.cash });
    const res = await ledger(
      `accountId=${a.cash}&fromDate=2026-01-01&toDate=2026-01-31&limit=1&cursor=${smuggled}`,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as Problem).code).toBe("ERR_VALIDATION_FAILED");
    // And a key that is not a date / posting_seq / line_no triple is 400, not a 500 out of `::date`.
    const garbage = encodeCursor({ k: ["yesterday", "seven", 1], id: a.cash });
    const bad = await ledger(
      `accountId=${a.cash}&fromDate=2026-01-01&toDate=2026-01-31&limit=1&cursor=${garbage}`,
    );
    expect(bad.status).toBe(400);
  });

  it("7A's runs sub-path is on THIS module, and 1B's two GETs still answer (hazard 31)", async () => {
    const { ROUTES } = await import("../../../src/routes");
    const modules = ROUTES.filter((m) => m.path === "/v1/companies/:companyId/reports");
    expect(modules).toHaveLength(1); // one module on one path
    expect(modules[0]!.permissions).toContain("accounting.report.export");
    expect(
      modules[0]!.router.routes.some((r) => r.method === "POST" && r.path === "/:code/runs"),
    ).toBe(true);
    expect((await tb(`fiscalPeriodId=${a.period}`)).status).toBe(200);
    expect((await ledger(`accountId=${a.cash}&fromDate=2026-01-01&toDate=2026-01-31`)).status).toBe(
      200,
    );
    // The reader holds accounting.report.read but not accounting.report.export: the POST is refused.
    const run = await api.request({
      method: "POST",
      path: `/v1/companies/${a.company}/reports/accounting.trial_balance/runs`,
      body: { parameters: { fiscalPeriodId: a.period }, format: "csv", lang: "en" },
      as: reader,
    });
    expect(run.status).toBe(403);
  });
});
