import { grantCodes } from "./fixtures";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lintSchema } from "../src/lint-schema";
import { issueDocument } from "../src/posting";
import { draftDocument, seedTenantV2, type Seed } from "./fixtures";
import { startDb, withTenant, type Db } from "./harness";

describe("document.posting_seq and fiscal_period.reopen_reason — contracts §4.3.5, spec:2179", () => {
  let db: Db;
  let a: Seed;

  beforeAll(async () => {
    db = await startDb();
    a = await seedTenantV2(db, "Alpha"); // V2: a JOURNAL policy issueDocument accepts
    await grantCodes(db, a); // 6C: explicit company-wide branch visibility; no permission codes.
  });
  afterAll(async () => {
    await db.stop();
  });

  // posting_seq is drawn at ISSUED, by postDocument's step 8; since code review 3 (0117) a draft carries none,
  // so the stamp below is taken where step 8 takes it.
  const issued = async (doc: string): Promise<string> => {
    await withTenant(db.rw, a.tenant, a.human, (tx) =>
      issueDocument(
        tx,
        { tenantId: a.tenant, actorId: a.human, requestId: "posting-seq" },
        { documentId: doc },
      ),
    );
    return doc;
  };

  it("app_rw may draw from app.posting_seq and the numbers strictly increase", async () => {
    const [first, second] = await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      const [x] = await tx<{ n: string }[]>`select nextval('app.posting_seq')::text as n`;
      const [y] = await tx<{ n: string }[]>`select nextval('app.posting_seq')::text as n`;
      return [BigInt(x!.n), BigInt(y!.n)];
    });
    expect(second!).toBeGreaterThan(first!);
  });

  it("a document starts with a null posting_seq and takes one only when stamped", async () => {
    const doc = await issued(await draftDocument(db, a));
    const before = await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx<{ posting_seq: string | null }[]>`
      select posting_seq::text as posting_seq from app.document where id = ${doc}`,
    );
    expect(before[0]!.posting_seq).toBeNull();

    await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx`
      update app.document set posting_seq = nextval('app.posting_seq') where id = ${doc} and posting_seq is null`,
    );
    const after = await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx<{ posting_seq: string | null }[]>`
      select posting_seq::text as posting_seq from app.document where id = ${doc}`,
    );
    expect(after[0]!.posting_seq).not.toBeNull();
  });

  it("two documents of one company cannot share a posting_seq", async () => {
    const one = await issued(await draftDocument(db, a));
    const two = await issued(await draftDocument(db, a));
    // 0117 admits only the value just drawn, so the second document is given the first's by `currval` in the
    // same session: the one value that clears the guard and reaches the unique constraint.
    await expect(
      withTenant(db.rw, a.tenant, a.human, async (tx) => {
        await tx`update app.document set posting_seq = nextval('app.posting_seq') where id = ${one}`;
        await tx`update app.document set posting_seq = currval('app.posting_seq') where id = ${two}`;
      }),
    ).rejects.toThrow(/document_company_id_posting_seq_key/);
  });

  it("a reopen reason lands in the audited after-image (spec:2179, ADR 0023)", async () => {
    await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx`
      update app.fiscal_period set status = 'open', reopen_reason = 'audit adjustment requested by the auditor'
       where id = ${a.closedPeriod}`,
    );
    const [row] = await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx<{ reason: string | null; actor: string }[]>`
      select after ->> 'reopen_reason' as reason, actor_id::text as actor
        from app.audit_log
       where table_name = 'fiscal_period' and row_id = ${a.closedPeriod} and action = 'update'
       order by seq desc limit 1`,
    );
    expect(row!.reason).toBe("audit adjustment requested by the auditor");
    expect(row!.actor).toBe(a.human);
  });

  it("leaves the schema linter with zero violations", async () => {
    expect(await lintSchema(db.admin)).toEqual([]);
  });
});
