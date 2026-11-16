import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { postDocument, transitionDocument, voidDocument } from "../src/posting";
import { withTenant as prodWithTenant } from "../src/with-tenant";
import {
  grantCodes,
  seedDocumentType,
  seedTenantV2,
  startDb,
  uuidv7,
  withTenant,
  type Db,
  type Seed,
} from "./index";

/**
 * A type whose ONLY difference from JOURNAL is the series it numbers into. The series on the header is not
 * the series the document ends up in: `issueDocument` writes `policy.numbering.series` back onto the row
 * (contracts §4.3.6), so a header written with 'GAP' against `a.docType` would still be numbered into 'JV' and
 * every `series_gaps('GAP', …)` assertion would pass for the wrong reason. `GAP_TEST` is contracts §4.14's
 * registered test-only code for exactly this.
 */
const GAP_POLICY = {
  version: 1,
  documentType: "GAP_TEST",
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
  numbering: { series: "GAP", assignAt: "issue" },
  reversal: { allowed: true, producesType: "GAP_TEST" },
  approval: { required: false, approve: null, post: "accounting.journal.post" },
  fxRoundingAccount: { from: "company.fx_rounding_account_id" },
  dimensions: { required: [] },
};

const ctx = (s: Seed) => ({ tenantId: s.tenant, actorId: s.human, requestId: "req-delete" });

describe("draft-only deletion and app.series_gaps — spec:2049, 2222, 2224 (SAH-041, SAH-051)", () => {
  let db: Db;
  let a: Seed;
  let gapType: string; // a type whose policy numbers into series "GAP"

  const draft = async (typeId?: string, series = "JV"): Promise<string> => {
    const id = await uuidv7(db.admin);
    await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      await tx`insert into app.document (id, tenant_id, company_id, document_type_id, series, effective_date, currency, branch_id)
               values (${id}, ${a.tenant}, ${a.company}, ${typeId ?? a.docType}, ${series}, '2026-01-15', 'MYR', ${a.hq})`;
      await tx`insert into app.document_line (tenant_id, company_id, document_id, line_no, account_id, debit)
               values (${a.tenant}, ${a.company}, ${id}, 1, ${a.cash}, 5.0000)`;
      await tx`insert into app.document_line (tenant_id, company_id, document_id, line_no, account_id, credit)
               values (${a.tenant}, ${a.company}, ${id}, 2, ${a.sales}, 5.0000)`;
    });
    return id;
  };

  const gaps = (series: string) =>
    prodWithTenant(
      db.rw,
      ctx(a),
      (tx) => tx<{ number: string }[]>`
        select number::text as number from app.series_gaps(${a.company}, ${series}, ${a.period}) order by 1`,
    );

  /** The counter row itself, so a "no gaps" assertion can be shown not to be vacuous. */
  const counter = (series: string) =>
    prodWithTenant(
      db.rw,
      ctx(a),
      (tx) => tx<{ next_number: string }[]>`
        select next_number::text as next_number from app.document_series
         where company_id = ${a.company} and series = ${series} and fiscal_period_id = ${a.period}`,
    );

  beforeAll(async () => {
    db = await startDb();
    a = await seedTenantV2(db, "Alpha");
    await grantCodes(db, a, { codes: ["accounting.journal.post"] });
    // effectiveFrom is passed explicitly so app.effective_policy picks this row for the 2026-01-15 documents.
    gapType = await seedDocumentType(db, a, {
      code: "GAP_TEST",
      policy: GAP_POLICY,
      effectiveFrom: "2026-01-01",
    });
  });
  afterAll(async () => {
    await db.stop();
  });

  it("app_rw holds DELETE on exactly five tables — the contracts §3.5.4 list after 0023", async () => {
    const rows = await db.admin<{ table_name: string; privilege_type: string }[]>`
      select table_name, privilege_type from information_schema.role_table_grants
       where grantee = 'app_rw' and table_schema = 'app'
         and privilege_type in ('DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER') order by 1, 2`;
    expect(rows).toEqual([
      { table_name: "document", privilege_type: "DELETE" },
      { table_name: "document_line", privilege_type: "DELETE" },
      { table_name: "idempotency_key", privilege_type: "DELETE" },
      { table_name: "role_assignment_branch", privilege_type: "DELETE" },
      { table_name: "role_permission", privilege_type: "DELETE" },
    ]);
  });

  it("a draft is deletable, its lines cascade, and the audit log keeps the before-image (spec:2049)", async () => {
    const d = await draft();
    await prodWithTenant(db.rw, ctx(a), (tx) => tx`delete from app.document where id = ${d}`);
    const [left] = await prodWithTenant(
      db.rw,
      ctx(a),
      (tx) => tx<{ docs: number; lines: number }[]>`
        select (select count(*)::int from app.document where id = ${d}) as docs,
               (select count(*)::int from app.document_line where document_id = ${d}) as lines`,
    );
    expect(left).toEqual({ docs: 0, lines: 0 });
    // app.audit_log's discriminator is `action` with lowercase labels (migration 0001 §8).
    const [audited] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from app.audit_log
       where table_name = 'document' and action = 'delete' and before ->> 'id' = ${d}`;
    expect(audited!.n).toBe(1);
  });

  it("an issued document cannot be deleted — the third clause of acceptance test 16", async () => {
    const d = await draft();
    await prodWithTenant(db.rw, ctx(a), (tx) =>
      transitionDocument(tx, ctx(a), { documentId: d, to: "issued" }),
    );
    await expect(
      prodWithTenant(db.rw, ctx(a), (tx) => tx`delete from app.document where id = ${d}`),
    ).rejects.toThrow(/ERR_DOC_NOT_DRAFT: document .* is issued/);
  });

  it("a posted document cannot be deleted, and neither can one of its lines (spec:2224)", async () => {
    const d = await draft();
    await prodWithTenant(db.rw, ctx(a), (tx) => postDocument(tx, ctx(a), { documentId: d }));
    await expect(
      prodWithTenant(db.rw, ctx(a), (tx) => tx`delete from app.document where id = ${d}`),
    ).rejects.toThrow(/ERR_DOC_NOT_DRAFT: document .* is posted/);
    await expect(
      prodWithTenant(
        db.rw,
        ctx(a),
        (tx) => tx`delete from app.document_line where document_id = ${d} and line_no = 1`,
      ),
    ).rejects.toThrow(/ERR_DOC_NOT_DRAFT: document .* is posted/);
  });

  it("a draft's individual line may be deleted", async () => {
    const d = await draft();
    await prodWithTenant(
      db.rw,
      ctx(a),
      (tx) => tx`delete from app.document_line where document_id = ${d} and line_no = 2`,
    );
    const [n] = await prodWithTenant(
      db.rw,
      ctx(a),
      (tx) =>
        tx<
          { n: number }[]
        >`select count(*)::int as n from app.document_line where document_id = ${d}`,
    );
    expect(n!.n).toBe(1);
  });

  it("a draft that already carries a document_event cannot be deleted — contracts §4.18 open item 4", async () => {
    // contracts §4.5.2 declares `foreign key (tenant_id, document_id) references app.document(tenant_id, id)`
    // on app.document_event with NO on-delete action, and the table is immutable to app_rw. So a draft that
    // has been round-tripped (draft → submitted → draft, the recalculation edge of spec:2081) or that has
    // received an override carries rows the parent DELETE cannot clear, and the delete fails with SQLSTATE
    // 23503 — surfaced by the route of Task 8 as ERR_CONFLICT_REFERENCE, not as ERR_DOC_NOT_DRAFT and not as
    // a success. This case PINS that behaviour so it is visible rather than latent; it is not the behaviour
    // spec:2049 wants, and the FK is contracts-verbatim, so 2B does not change it unilaterally (ADR 0030).
    const d = await draft();
    await prodWithTenant(db.rw, ctx(a), (tx) =>
      transitionDocument(tx, ctx(a), { documentId: d, to: "submitted", reason: "for review" }),
    );
    await prodWithTenant(db.rw, ctx(a), (tx) =>
      transitionDocument(tx, ctx(a), { documentId: d, to: "draft", reason: "figures changed" }),
    );
    const [events] = await prodWithTenant(
      db.rw,
      ctx(a),
      (tx) =>
        tx<
          { n: number }[]
        >`select count(*)::int as n from app.document_event where document_id = ${d}`,
    );
    expect(events!.n).toBe(2);
    const [status] = await prodWithTenant(
      db.rw,
      ctx(a),
      (tx) =>
        tx<{ status: string }[]>`select status::text as status from app.document where id = ${d}`,
    );
    expect(status!.status).toBe("draft"); // the draft-only guard would admit it

    // The regex admits both spellings: the raw PG text when the driver error surfaces unwrapped, and the code
    // `fromDatabaseError` maps SQLSTATE 23503 to (0B, §4.2.4) if it is translated on the way out.
    await expect(
      prodWithTenant(db.rw, ctx(a), (tx) => tx`delete from app.document where id = ${d}`),
    ).rejects.toThrow(/violates foreign key constraint|ERR_CONFLICT_REFERENCE/);
  });

  it("series_gaps is empty for a clean series and stays empty when a number is voided", async () => {
    const first = await draft(gapType, "GAP");
    const second = await draft(gapType, "GAP");
    await prodWithTenant(db.rw, ctx(a), (tx) =>
      transitionDocument(tx, ctx(a), { documentId: first, to: "issued" }),
    );
    await prodWithTenant(db.rw, ctx(a), (tx) =>
      transitionDocument(tx, ctx(a), { documentId: second, to: "issued" }),
    );

    // The non-vacuity guard: series_gaps returns zero rows for a counter that does not exist, so the two
    // assertions below would pass on an empty database. This one proves the counter really advanced to 3,
    // which means [1, 3) is a range series_gaps actually walks.
    expect((await counter("GAP")).map((r) => r.next_number)).toEqual(["3"]);
    const [numbers] = await prodWithTenant(
      db.rw,
      ctx(a),
      (tx) => tx<{ ns: string }[]>`
        select string_agg(number::text, ',' order by number) as ns from app.document
         where company_id = ${a.company} and series = 'GAP' and fiscal_period_id = ${a.period}`,
    );
    expect(numbers!.ns).toBe("1,2");

    expect(await gaps("GAP")).toEqual([]);
    await prodWithTenant(db.rw, ctx(a), (tx) =>
      voidDocument(tx, ctx(a), { documentId: second, reason: "printer jam; reissued" }),
    );
    // Two separate facts. (a) The void RECORD exists — the `voided.n === 1` assertion, the "voided numbers are
    // recorded" clause of acceptance test 16. (b) The series is still whole. It is NOT (b) that proves (a)
    // explains it: `voidDocument` updates only `status` and leaves `document.number` in place, so number 2 is
    // still excluded by series_gaps' FIRST predicate. The void row's own effect is isolated in the next case.
    const [voided] = await prodWithTenant(
      db.rw,
      ctx(a),
      (tx) => tx<{ n: number }[]>`
        select count(*)::int as n from app.document_number_void
         where company_id = ${a.company} and series = 'GAP' and fiscal_period_id = ${a.period} and number = 2`,
    );
    expect(voided!.n).toBe(1);
    expect(await gaps("GAP")).toEqual([]);
  });

  it("a recorded void is what explains a number: series_gaps skips the voided one and names its neighbour", async () => {
    // A series with NO document at all, a counter advanced past 1 and 2, and exactly one of the two recorded
    // as voided. The void row is now the only possible explanation for number 1, so the assertion bites — drop
    // the `document_number_void` predicate from app.series_gaps and this returns ["1", "2"].
    await withTenant(db.migrator, a.tenant, a.system, async (tx) => {
      await tx`insert into app.document_series (tenant_id, company_id, series, fiscal_period_id, next_number)
               values (${a.tenant}, ${a.company}, 'VOIDONLY', ${a.period}, 3)`;
      await tx`insert into app.document_number_void (tenant_id, company_id, series, fiscal_period_id, number, reason)
               values (${a.tenant}, ${a.company}, 'VOIDONLY', ${a.period}, 1, 'recorded void with no surviving document')`;
    });
    expect((await gaps("VOIDONLY")).map((r) => r.number)).toEqual(["2"]);
  });

  it("series_gaps names the number when the counter has advanced past an unexplained one", async () => {
    // The only way to manufacture one is to advance the counter as the migrator without issuing — exactly the
    // shape a bug in the posting service would produce, which is what the nightly job must catch.
    await withTenant(
      db.migrator,
      a.tenant,
      a.system,
      (tx) => tx`
        insert into app.document_series (tenant_id, company_id, series, fiscal_period_id, next_number)
        values (${a.tenant}, ${a.company}, 'HOLE', ${a.period}, 4)`,
    );
    expect((await gaps("HOLE")).map((r) => r.number)).toEqual(["1", "2", "3"]);
  });

  it("series_gaps is tenant-scoped: another tenant's counters are invisible", async () => {
    const b = await seedTenantV2(db, "Beta");
    const rows = await prodWithTenant(
      db.rw,
      { tenantId: b.tenant, actorId: b.human, requestId: "r" },
      (tx) => tx<{ number: string }[]>`
        select number::text as number from app.series_gaps(${a.company}, 'HOLE', ${a.period})`,
    );
    expect(rows).toEqual([]);
  });
});
