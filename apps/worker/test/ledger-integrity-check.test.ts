import type { Sql } from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { IntegrityReport } from "@dulja/db";
import {
  draftDocument,
  seedTenant,
  grantCodes,
  uuidv7,
  withTenant,
  type Seed,
} from "@dulja/db/test";
import { startWorker, type StartedWorker } from "./support/worker";

/**
 * The corruption scenarios 0D wrote for its scaffold, re-pointed at the handler that ships
 * (createIntegrityCheckHandler, registered by the same registerAccountingHandlers production calls). The
 * handler RECORDS rather than throws: a failing run writes an `integrity_incident` audit row inside the hash
 * chain, raises the IncidentReporter (which with no SENTRY_DSN is the "integrity incident" error line) and
 * logs "ledger integrity check failed". ADR 0024. The per-tenant, per-scenario shape is kept because each
 * scenario corrupts its own tenant and must not see another's.
 */
describe("accounting.ledger.integrity_check — the corruption the application cannot cause", () => {
  let worker: StartedWorker;
  let alpha: Seed;
  let beta: Seed;
  let gamma: Seed;
  let delta: Seed;
  let epsilon: Seed;
  let zeta: Seed;
  let eta: Seed;
  beforeAll(async () => {
    worker = await startWorker();
    alpha = await seedTenant(worker.db, "Alpha");
    beta = await seedTenant(worker.db, "Beta");
    gamma = await seedTenant(worker.db, "Gamma");
    delta = await seedTenant(worker.db, "Delta");
    epsilon = await seedTenant(worker.db, "Epsilon");
    zeta = await seedTenant(worker.db, "Zeta");
    eta = await seedTenant(worker.db, "Eta");
    for (const seed of [alpha, beta, gamma, delta, epsilon, zeta, eta])
      await grantCodes(worker.db, seed);
  });
  afterAll(async () => {
    await worker.stop();
  });
  beforeEach(() => {
    worker.logs.length = 0;
  });
  const run = async (tenantId: string) =>
    worker.run("accounting.ledger.integrity_check", {
      tenantId,
      requestId: await uuidv7(worker.db.admin),
      payload: {},
    });
  const errorMessages = () =>
    worker.logs.filter((entry) => entry.level === "error").map((entry) => entry.msg);
  const passed = () => worker.logs.find((entry) => entry.msg === "ledger integrity check passed");
  const incidentFor = async (seed: Seed): Promise<IntegrityReport> => {
    const [row] = await withTenant(
      worker.db.rw,
      seed.tenant,
      seed.system,
      (tx) => tx<{ after: IntegrityReport }[]>`
      select after from app.audit_log
       where tenant_id = ${seed.tenant} and table_name = 'integrity_incident' order by seq desc limit 1`,
    );
    expect(row, "an integrity_incident audit row").toBeDefined();
    return row!.after;
  };

  /**
   * Corruption the application cannot cause: every app path to `audit_log` and `ledger_entry` is closed
   * by a trigger, which is what the test below this one proves. The job exists for what is left — a bad
   * restore, a storage fault, a DBA acting outside the application — so proving the alarm fires means
   * reproducing damage of that kind. `set local session_replication_role = replica` suppresses trigger
   * firing for one superuser transaction and reverts at commit; no trigger, constraint or policy is
   * dropped or disabled, and no application role can do this.
   */
  const asCorruption = async (write: (tx: Sql) => Promise<unknown>) =>
    worker.db.admin.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await write(tx as unknown as Sql);
    });

  /**
   * A document carrying one side only. The per-row CHECKs still hold — those are constraints, not
   * triggers, so replica mode does not suspend them; what is suspended is the deferred balance
   * assertion that the posting service relies on.
   */
  const oneSidedDocument = async (seed: Seed, debit: string, credit: string): Promise<string> => {
    const documentId = await draftDocument(worker.db, seed);
    const entryId = await uuidv7(worker.db.admin);
    await asCorruption(
      (tx) => tx`insert into app.ledger_entry
        (id, tenant_id, company_id, document_id, line_no, account_id, debit, credit, currency,
         exchange_rate, base_debit, base_credit, effective_date, fiscal_period_id, posting_policy_id, posted_by)
        values (${entryId}, ${seed.tenant}, ${seed.company}, ${documentId}, 1, ${seed.cash}, ${debit}, ${credit},
                'MYR', 1, ${debit}, ${credit}, '2026-01-15', ${seed.period}, ${seed.policy}, ${seed.system})`,
    );
    return documentId;
  };

  it("reports no postings with an intact tenant-scoped audit chain", async () => {
    await run(alpha.tenant);
    const line = passed()!;
    expect(line).toBeDefined();
    expect(line.level).toBe("info");
    expect(line.fields).toMatchObject({
      tenant_id: alpha.tenant,
      actor_id: alpha.system,
      summary: "no postings",
    });
    expect(errorMessages()).toEqual([]);
  });

  it("the immutable trigger rejects an attempted chain-hash tamper", async () => {
    await expect(
      worker.db
        .admin`update app.audit_log set hash = sha256('tampered') where tenant_id = ${beta.tenant} and seq = (select min(seq) from app.audit_log where tenant_id = ${beta.tenant})`,
    ).rejects.toThrow(/ERR_TABLE_IMMUTABLE/);
    await run(beta.tenant);
    expect(passed()!.fields).toMatchObject({ tenant_id: beta.tenant, summary: "no postings" });
  });

  it("records an incident and raises the alarm when a chain hash no longer matches its row", async () => {
    await asCorruption(
      (tx) => tx`update app.audit_log set hash = sha256('tampered')
                 where tenant_id = ${gamma.tenant}
                   and seq = (select min(seq) from app.audit_log where tenant_id = ${gamma.tenant})`,
    );
    await run(gamma.tenant);
    // The IncidentReporter's own line first, then the handler's — both at error level.
    expect(errorMessages()).toEqual(["integrity incident", "ledger integrity check failed"]);
    const alarm = worker.logs.find((entry) => entry.msg === "integrity incident")!;
    expect(alarm.fields).toMatchObject({
      incident: "accounting.ledger.integrity_check",
      tenant_id: gamma.tenant,
    });
    expect(alarm.fields["bad_hashes"] as number).toBeGreaterThan(0);
    const report = await incidentFor(gamma);
    expect(report.ok).toBe(false);
    expect(report.auditChain.badHashes).toBeGreaterThan(0);
    expect(report.auditChain.firstBrokenSeq).not.toBeNull();
  });

  it("records an incident on an unbalanced document (§4.9 SLI)", async () => {
    await oneSidedDocument(delta, "100", "0");
    await run(delta.tenant);
    expect(errorMessages()).toEqual(["integrity incident", "ledger integrity check failed"]);
    const report = await incidentFor(delta);
    expect(report.ledgerBalance.byDocument).toHaveLength(1);
    expect(report.ledgerBalance.byDocument[0]).toMatchObject({
      scope: "document",
      companyId: delta.company,
      difference: "100.0000",
    });
  });

  it("does not report a balanced document whose lines are in different currencies", async () => {
    // The false positive the old grouping produced: base amounts already sit in the company's currency, so
    // a USD line and a MYR line belong to one document-level sum, not to two per-currency ones. The
    // matching account_balance rows are written too, so the projection half of the check is clean and the
    // run passes outright. `ledger_entry.currency` is a foreign key (migration 0008), so the foreign leg
    // needs a currency row of its own — written idempotently, for the reason
    // `packages/db/test/currency-fk.test.ts` writes its own that way.
    await withTenant(
      worker.db.rw,
      epsilon.tenant,
      epsilon.human,
      (tx) => tx`insert into app.currency (tenant_id, code, name_en)
                 values (${epsilon.tenant}, 'USD', 'US dollar')
                 on conflict (tenant_id, code) do nothing`,
    );
    const documentId = await draftDocument(worker.db, epsilon);
    await withTenant(worker.db.rw, epsilon.tenant, epsilon.human, async (tx) => {
      await tx`insert into app.ledger_entry
        (tenant_id, company_id, document_id, line_no, account_id, debit, credit, currency,
         exchange_rate, base_debit, base_credit, effective_date, fiscal_period_id, posting_policy_id)
        values
        (${epsilon.tenant}, ${epsilon.company}, ${documentId}, 1, ${epsilon.cash}, '100.0000', '0', 'USD',
         '4.00000000', '400.0000', '0', '2026-01-15', ${epsilon.period}, ${epsilon.policy}),
        (${epsilon.tenant}, ${epsilon.company}, ${documentId}, 2, ${epsilon.sales}, '0', '400.0000', 'MYR',
         '1.00000000', '0', '400.0000', '2026-01-15', ${epsilon.period}, ${epsilon.policy})`;
      await tx`insert into app.account_balance
        (tenant_id, company_id, account_id, fiscal_period_id, currency, debit, credit, base_debit, base_credit)
        values
        (${epsilon.tenant}, ${epsilon.company}, ${epsilon.cash}, ${epsilon.period}, 'USD', '100.0000', '0', '400.0000', '0'),
        (${epsilon.tenant}, ${epsilon.company}, ${epsilon.sales}, ${epsilon.period}, 'MYR', '0', '400.0000', '0', '400.0000')`;
    });
    await run(epsilon.tenant);
    expect(errorMessages()).toEqual([]);
    const line = passed()!;
    expect(line).toBeDefined();
    expect(line.fields["summary"]).toMatch(/^ok: 2 ledger entries/);
  });

  it("catches two unbalanced documents whose errors offset each other", async () => {
    // The masking case: same company, same period, same currency, deltas +100 and -100. Summed per period
    // they vanish; summed per document — the way `app.assert_document_balanced` sums — there are two.
    await oneSidedDocument(zeta, "100", "0");
    await oneSidedDocument(zeta, "0", "100");
    await run(zeta.tenant);
    const report = await incidentFor(zeta);
    expect(report.ledgerBalance.byPeriod).toEqual([]);
    expect(report.ledgerBalance.byDocument).toHaveLength(2);
  });

  it("reports every breach in ONE report rather than stopping at the first", async () => {
    // A restore bad enough to rewrite the audit log rarely leaves the ledger alone, and the operator who
    // repairs the chain should not have to run the job again to learn the ledger is off too.
    await oneSidedDocument(eta, "100", "0");
    await asCorruption(
      (tx) => tx`update app.audit_log set hash = sha256('tampered')
                 where tenant_id = ${eta.tenant}
                   and seq = (select min(seq) from app.audit_log where tenant_id = ${eta.tenant})`,
    );
    await run(eta.tenant);
    const report = await incidentFor(eta);
    expect(report.auditChain.badHashes).toBeGreaterThan(0);
    expect(report.ledgerBalance.byDocument).toHaveLength(1);
    expect(report.summary).toMatch(/^FAILED: /);
    // One alarm, one failure line — never one per breach.
    expect(errorMessages()).toEqual(["integrity incident", "ledger integrity check failed"]);
  });

  it("runs as the tenant's system principal, never a human (spec §4.2.2 R8)", async () => {
    await run(alpha.tenant);
    const line = passed()!;
    expect(line.fields["actor_id"]).toBe(alpha.system);
    expect(line.fields["actor_id"]).not.toBe(alpha.human);
  });

  it("sees only its own tenant's rows — gamma's tampered chain and delta's broken ledger are invisible to alpha", async () => {
    await run(alpha.tenant);
    expect(errorMessages()).toEqual([]);
    expect(passed()!.fields).toMatchObject({ tenant_id: alpha.tenant, summary: "no postings" });
  });
});
