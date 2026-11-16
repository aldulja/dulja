import type { Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
  JobClient,
  JobEnvelope,
  JobName,
  JobPayload,
  EnqueueOptions,
} from "../../src/jobs/enqueue";
import { postDocument } from "../../src/posting";
import { listTransmissions } from "../../src/einvoice/transmission";
import { withTenant as prodWithTenant } from "../../src/with-tenant";
import { startDb, uuidv7, withTenant, type Db } from "../harness";
import {
  JOURNAL_POLICY_V1,
  draftDocument,
  grantCodes,
  seedDocumentType,
  seedTenantV2,
  type Seed,
} from "../fixtures";
import { enableEinvoice } from "../support/einvoice-stub";

interface Recorded {
  name: JobName;
  envelope: JobEnvelope<unknown>;
  opts: unknown;
}

/** A recording JobClient, file-local. 3B ships `recordingJobs()` in `tests/invariants/support/`,
 *  which `packages/db/test/**` may not import (amendment 10); eight lines here beats a lint
 *  allowance that would point this package at the test tier. */
function recordingJobs(): JobClient & { readonly enqueued: readonly Recorded[] } {
  const enqueued: Recorded[] = [];
  return {
    enqueued,
    async enqueue<N extends JobName>(
      _tx: Sql,
      name: N,
      job: JobEnvelope<JobPayload[N]>,
      opts?: EnqueueOptions,
    ) {
      enqueued.push({ name, envelope: job as JobEnvelope<unknown>, opts });
      return `job-${enqueued.length}`;
    },
  } as JobClient & { readonly enqueued: readonly Recorded[] };
}

/** Configure JOURNAL at v3 with a tax block. No new document-type code (hazard 32). */
async function optInJournal(db: Db, s: Seed, einvoice: boolean): Promise<void> {
  await seedDocumentType(db, s, {
    code: "JOURNAL",
    module: "accounting",
    policy: { ...JOURNAL_POLICY_V1, tax: { applies: true, einvoice } },
    policyVersion: 3,
    effectiveFrom: "2026-01-01",
  });
}

describe("§4.3.2 step 14 — the three e-invoicing gates (contracts amendment 3)", () => {
  let db: Db;
  let s: Seed;
  let ctx: { tenantId: string; actorId: string; requestId: string };

  beforeAll(async () => {
    db = await startDb();
    s = await seedTenantV2(db, "einvoice-step14");
    ctx = { tenantId: s.tenant, actorId: s.human, requestId: await uuidv7(db.admin) };
    await grantCodes(db, s, { codes: ["accounting.journal.create", "accounting.journal.post"] });
  }, 180_000);

  afterAll(async () => {
    await db.stop();
  });

  const postOne = async (
    jobs?: JobClient,
  ): Promise<{ documentId: string; warnings: string[]; enqueued: string[] }> => {
    const documentId = await draftDocument(db, s);
    await withTenant(db.rw, s.tenant, s.human, async (tx) => {
      await tx`insert into app.document_line (tenant_id, company_id, document_id, line_no, kind, account_id, debit, credit)
               values (app.current_tenant(), ${s.company}, ${documentId}, 1, 'account', ${s.cash}, 25.0000, 0)`;
      await tx`insert into app.document_line (tenant_id, company_id, document_id, line_no, kind, account_id, debit, credit)
               values (app.current_tenant(), ${s.company}, ${documentId}, 2, 'account', ${s.sales}, 0, 25.0000)`;
    });
    const result = await prodWithTenant(db.rw, ctx, (tx) =>
      postDocument(tx, ctx, { documentId, ...(jobs ? { jobs } : {}) }),
    );
    return { documentId, warnings: result.warnings, enqueued: result.enqueuedJobIds };
  };

  it("GATE 1 — tax.applies false: no transmission row, no enqueue, no warning", async () => {
    await optInJournal(db, s, false);
    await seedDocumentType(db, s, {
      code: "JOURNAL",
      module: "accounting",
      policy: { ...JOURNAL_POLICY_V1, tax: { applies: false } },
      policyVersion: 4,
      effectiveFrom: "2026-01-01",
    });
    await enableEinvoice(db, s);
    const jobs = recordingJobs();
    const { documentId, warnings } = await postOne(jobs);
    const rows = await prodWithTenant(db.rw, ctx, (tx) =>
      listTransmissions(tx, { companyId: s.company, limit: 10 }),
    );
    expect(rows.filter((r) => r.documentId === documentId)).toHaveLength(0);
    expect(jobs.enqueued.filter((j) => j.name === "accounting.tax.submit")).toHaveLength(0);
    expect(warnings.some((w) => w.startsWith("einvoice_"))).toBe(false);
  });

  it("GATE 2 — tax.applies true but tax.einvoice absent: still nothing (default false)", async () => {
    await seedDocumentType(db, s, {
      code: "JOURNAL",
      module: "accounting",
      policy: { ...JOURNAL_POLICY_V1, tax: { applies: true } },
      policyVersion: 5,
      effectiveFrom: "2026-01-01",
    });
    await enableEinvoice(db, s);
    const jobs = recordingJobs();
    const { documentId } = await postOne(jobs);
    const rows = await prodWithTenant(db.rw, ctx, (tx) =>
      listTransmissions(tx, { companyId: s.company, limit: 10 }),
    );
    expect(rows.filter((r) => r.documentId === documentId)).toHaveLength(0);
    expect(jobs.enqueued.filter((j) => j.name === "accounting.tax.submit")).toHaveLength(0);
  });

  it("GATE 3 — both policy gates on but the company has no transmitter: still nothing", async () => {
    await seedDocumentType(db, s, {
      code: "JOURNAL",
      module: "accounting",
      policy: { ...JOURNAL_POLICY_V1, tax: { applies: true, einvoice: true } },
      policyVersion: 6,
      effectiveFrom: "2026-01-01",
    });
    await withTenant(db.rw, s.tenant, s.human, async (tx) => {
      await tx`update app.company
                  set einvoice_transmitter = null, einvoice_client_id = null,
                      einvoice_credential_ref = null
                where id = ${s.company}`;
    });
    const jobs = recordingJobs();
    const { documentId } = await postOne(jobs);
    const rows = await prodWithTenant(db.rw, ctx, (tx) =>
      listTransmissions(tx, { companyId: s.company, limit: 10 }),
    );
    expect(rows.filter((r) => r.documentId === documentId)).toHaveLength(0);
    expect(jobs.enqueued.filter((j) => j.name === "accounting.tax.submit")).toHaveLength(0);
  });

  it("ALL THREE ON — one pending row and one enqueue with the fixed options", async () => {
    await enableEinvoice(db, s);
    const jobs = recordingJobs();
    const { documentId, enqueued } = await postOne(jobs);

    const rows = await prodWithTenant(db.rw, ctx, (tx) =>
      listTransmissions(tx, { companyId: s.company, limit: 50 }),
    );
    const mine = rows.filter((r) => r.documentId === documentId);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.status).toBe("pending");
    expect(mine[0]!.transmitter).toBe("synthetic");
    expect(mine[0]!.attempts).toBe(0);

    const job = jobs.enqueued.find((j) => j.name === "accounting.tax.submit");
    expect(job).toBeDefined();
    expect(job!.envelope.tenantId).toBe(s.tenant);
    expect(job!.envelope.requestId).toBe(ctx.requestId);
    expect(job!.envelope.payload).toEqual({ transmissionId: mine[0]!.id, phase: "submit" });
    expect(job!.opts).toEqual({ singletonKey: mine[0]!.id, retryLimit: 8, retryDelaySeconds: 60 });
    expect(enqueued).toContain("job-1");
  });

  it("NO JOB CLIENT — the row is still written and the warning names it (amendment 3)", async () => {
    await enableEinvoice(db, s);
    const { documentId, warnings } = await postOne(undefined);
    const rows = await prodWithTenant(db.rw, ctx, (tx) =>
      listTransmissions(tx, { companyId: s.company, limit: 50 }),
    );
    const mine = rows.filter((r) => r.documentId === documentId);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.status).toBe("pending");
    const warning = warnings.find((w) => w.startsWith("einvoice_enqueue_skipped"));
    expect(warning).toBeDefined();
    expect(warning).toContain(mine[0]!.id);
  });

  it("a rolled-back post leaves NO transmission row (the row is in the posting transaction)", async () => {
    await enableEinvoice(db, s);
    const documentId = await draftDocument(db, s);
    // One line only: §4.3.2 step 6's balance check refuses, so the whole transaction rolls back.
    await withTenant(db.rw, s.tenant, s.human, async (tx) => {
      await tx`insert into app.document_line (tenant_id, company_id, document_id, line_no, kind, account_id, debit, credit)
               values (app.current_tenant(), ${s.company}, ${documentId}, 1, 'account', ${s.cash}, 25.0000, 0)`;
    });
    await expect(
      prodWithTenant(db.rw, ctx, (tx) => postDocument(tx, ctx, { documentId })),
    ).rejects.toThrow();
    const rows = await prodWithTenant(db.rw, ctx, (tx) =>
      listTransmissions(tx, { companyId: s.company, limit: 50 }),
    );
    expect(rows.filter((r) => r.documentId === documentId)).toHaveLength(0);
  });

  it("posting the SAME document twice cannot create two rows (unique (tenant_id, document_id))", async () => {
    // §4.3.2 step 2 refuses a second post of a posted document, so this asserts the DDL rather than
    // the algorithm: recordPending is `on conflict (tenant_id, document_id) do update`, which is why
    // a reversal-and-repost path (2B) reuses the row instead of raising 23505 inside a post.
    await enableEinvoice(db, s);
    const { documentId } = await postOne(recordingJobs());
    const again = await prodWithTenant(db.rw, ctx, async (tx) => {
      const rows = await tx<{ id: string }[]>`
        select id::text as id from app.einvoice_transmission where document_id = ${documentId}`;
      return rows.length;
    });
    expect(again).toBe(1);
  });
});
