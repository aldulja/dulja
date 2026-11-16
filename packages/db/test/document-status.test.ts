import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  grantCodes,
  seedBranch,
  seedDocumentType,
  seedTenantV2,
  startDb,
  uuidv7,
  withTenant,
  type Db,
  type Seed,
} from "./index";

/** A JOURNAL-shaped policy that REQUIRES approval, so the maker-checker rules engage. Both codes are in the
 *  catalogue at 2B, which is what validatePolicy demands (F-21, contracts §4.4.1). The type is `POLICY_TEST`,
 *  §4.14's registered test-only code — hazard 32 forbids inventing a `STRICT` for the purpose. */
const STRICT_POLICY = {
  version: 1,
  documentType: "POLICY_TEST",
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
  numbering: { series: "PT", assignAt: "issue" },
  reversal: { allowed: true, producesType: "POLICY_TEST" },
  approval: { required: true, approve: "accounting.journal.post", post: "accounting.journal.post" },
  fxRoundingAccount: { from: "company.fx_rounding_account_id" },
  dimensions: { required: [] },
};

/**
 * The transition matrix, R1 and R2 exercised where they live: a direct `app_rw` UPDATE. Everything the API
 * and the jobs do reduces to this statement, so a rule proven here is proven for every path (spec:2172).
 */
describe("app.document_status_before / _after — contracts §4.5.1, spec:2172–2173 (SAH-032)", () => {
  let db: Db;
  let a: Seed;
  let approver: string;
  let poster: string;
  /** A type whose policy declares approval.required, so R1 and R2 both engage. */
  let strictType: string;

  const person = async (label: string): Promise<string> => {
    const id = await uuidv7(db.admin);
    await withTenant(db.migrator, a.tenant, a.system, async (tx) => {
      await tx`insert into app.principal (id, kind, auth_subject, display_name)
               values (${id}, 'human', ${`${label}:${a.tenant}`}, ${label})`;
      await tx`insert into app.membership (tenant_id, principal_id) values (${a.tenant}, ${id})`;
    });
    return id;
  };

  /**
   * A document of `typeId` INSERTED DIRECTLY at `status`, with two balanced lines so it could be posted if the
   * test wanted to. Both status triggers are `... update of status` triggers, so an INSERT fires neither: a row
   * created here at `submitted` carries **no `document_event` history at all**. That is the only way to reach
   * the state R1's first clause guards against, because every UPDATE into `submitted` writes the submitted
   * event itself — which is exactly why `ERR_SOD_NO_SUBMISSION` is unreachable from a `draft` row (the matrix
   * of block 2a refuses `draft → approved` with `ERR_DOC_STATUS_ILLEGAL` before R1 is ever evaluated).
   *
   * Lines are written only when `status` is `draft`: since migration 0113 a line can be added only to a draft
   * (ERR_DOC_NOT_DRAFT), and R1's cases, the one caller that starts elsewhere, need none.
   */
  const draftAt = async (typeId: string, series: string, status: string): Promise<string> => {
    const id = await uuidv7(db.admin);
    await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      await tx`insert into app.document (id, tenant_id, company_id, document_type_id, series, status, effective_date, currency, branch_id)
               values (${id}, ${a.tenant}, ${a.company}, ${typeId}, ${series}, ${status}::app.document_status, '2026-01-15', 'MYR', ${a.hq})`;
      if (status !== "draft") return;
      await tx`insert into app.document_line (tenant_id, company_id, document_id, line_no, account_id, debit)
               values (${a.tenant}, ${a.company}, ${id}, 1, ${a.cash}, 10.0000)`;
      await tx`insert into app.document_line (tenant_id, company_id, document_id, line_no, account_id, credit)
               values (${a.tenant}, ${a.company}, ${id}, 2, ${a.sales}, 10.0000)`;
    });
    return id;
  };

  /** A draft of `typeId` — the ordinary starting point for every case but R1's first. */
  const draft = (typeId: string, series: string): Promise<string> =>
    draftAt(typeId, series, "draft");

  /** One status update as `actor`, with the reason carried through the transaction settings. */
  const move = (
    docId: string,
    to: string,
    actor: string,
    reason: string | null = null,
  ): Promise<unknown> =>
    withTenant(db.rw, a.tenant, actor, async (tx) => {
      await tx`select set_config('app.event_reason', ${reason ?? ""}, true),
                      set_config('app.event_attributed_to', '', true)`;
      await tx`update app.document set status = ${to}::app.document_status where id = ${docId}`;
    });

  const events = (docId: string) =>
    withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx<
        { from_status: string; to_status: string; actor_id: string; reason: string | null }[]
      >`select from_status::text as from_status, to_status::text as to_status, actor_id, reason
          from app.document_event where document_id = ${docId} and event_kind = 'transition' order by id`,
    );

  beforeAll(async () => {
    db = await startDb();
    a = await seedTenantV2(db, "Alpha");
    approver = await person("approver");
    poster = await person("poster");
    await grantCodes(db, a, { principalId: a.human, codes: ["accounting.journal.post"] });
    await grantCodes(db, a, { principalId: approver, codes: ["accounting.journal.post"] });
    await grantCodes(db, a, { principalId: poster, codes: ["accounting.journal.post"] });
    strictType = await seedDocumentType(db, a, { code: "POLICY_TEST", policy: STRICT_POLICY });
  });
  afterAll(async () => {
    await db.stop();
  });

  it("admits draft → submitted always, and records the transition with its actor and reason", async () => {
    const d = await draft(strictType, "PT");
    await move(d, "submitted", a.human, "ready for review");
    expect(await events(d)).toEqual([
      {
        from_status: "draft",
        to_status: "submitted",
        actor_id: a.human,
        reason: "ready for review",
      },
    ]);
  });

  it("refuses draft → issued when the policy requires approval, and admits it when it does not", async () => {
    const strict = await draft(strictType, "PT");
    await expect(move(strict, "issued", a.human)).rejects.toThrow(
      /ERR_DOC_STATUS_ILLEGAL: draft → issued needs approval\.required = false/,
    );
    const loose = await draft(a.docType, "JV"); // JOURNAL_POLICY_V1: approval.required = false
    await move(loose, "issued", a.human);
    expect((await events(loose)).at(-1)).toMatchObject({
      from_status: "draft",
      to_status: "issued",
    });
  });

  it("R1: approving a submitted document that carries no submitted event is ERR_SOD_NO_SUBMISSION", async () => {
    // The document is INSERTED at `submitted`, not moved there: the matrix (block 2a) runs BEFORE R1 (block
    // 2b), so `draft → approved` is refused as an illegal pair and R1 is never reached. An INSERT fires no
    // `update of status` trigger, so this row is `submitted` with an empty event log — the one state in which
    // R1's first clause can speak, and the state a bad importer or a hand-written INSERT would produce.
    const d = await draftAt(strictType, "PT", "submitted");
    await expect(move(d, "approved", approver)).rejects.toThrow(
      /ERR_SOD_NO_SUBMISSION: document .* has no submitted event/,
    );
  });

  it("R1: the submitter cannot approve or post their own document (spec:2172)", async () => {
    const d = await draft(strictType, "PT");
    await move(d, "submitted", a.human, "mine");
    await expect(move(d, "approved", a.human)).rejects.toThrow(
      /ERR_SOD_MAKER_IS_CHECKER: principal .* submitted document .* and cannot approve it/,
    );
    await move(d, "approved", approver, "checked");
    await move(d, "issued", approver);
    await expect(move(d, "posted", a.human)).rejects.toThrow(
      /ERR_SOD_MAKER_IS_CHECKER: principal .* submitted document .* and cannot post it/,
    );
  });

  it("R2: approval and posting are refused to a principal without the policy's code (spec:2173, SAH-032)", async () => {
    const nobody = await person("nobody");
    await grantCodes(db, a, { principalId: nobody });
    const d = await draft(strictType, "PT");
    await move(d, "submitted", a.human, "for review");
    await expect(move(d, "approved", nobody)).rejects.toThrow(
      /ERR_RBAC_FORBIDDEN: principal .* does not hold accounting\.journal\.post/,
    );
  });

  it("R2: a branch-restricted principal is refused at another branch and admitted at its own (SAH-042)", async () => {
    const branchOnly = await person("branch-only");
    // Reach both branches without their posting code, so this still exercises R2.
    await grantCodes(db, a, { principalId: branchOnly });
    await grantCodes(db, a, {
      principalId: branchOnly,
      codes: ["accounting.journal.post"],
      branchIds: [a.hq],
    });
    const d = await draft(strictType, "PT");
    await move(d, "submitted", a.human, "for review");
    await move(d, "approved", branchOnly, "at my own branch"); // document.branch_id = a.hq
    expect((await events(d)).at(-1)).toMatchObject({ to_status: "approved", actor_id: branchOnly });

    // The registered fixture, not a hand-rolled INSERT: contracts §4.17 makes seedBranch (0D) the one way a
    // test creates a second BRANCH dimension_value, and §4.17's preamble makes that register binding.
    const other = await seedBranch(db, a, { code: "KL01", nameEn: "Kuala Lumpur shop" });
    const elsewhere = await uuidv7(db.admin);
    await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx`
        insert into app.document (id, tenant_id, company_id, document_type_id, series, effective_date, currency, branch_id)
        values (${elsewhere}, ${a.tenant}, ${a.company}, ${strictType}, 'PT', '2026-01-15', 'MYR', ${other})`,
    );
    await move(elsewhere, "submitted", a.human, "for review");
    await expect(move(elsewhere, "approved", branchOnly)).rejects.toThrow(
      /ERR_RBAC_FORBIDDEN: principal .* does not hold accounting\.journal\.post at branch/,
    );
  });

  it("the backward edge needs a reason, and is the only backward edge", async () => {
    const d = await draft(strictType, "PT");
    await move(d, "submitted", a.human, "for review");
    await expect(move(d, "draft", a.human)).rejects.toThrow(
      /ERR_DOC_STATUS_ILLEGAL: returning document .* from submitted to draft is a recalculation and needs a reason/,
    );
    await move(d, "draft", a.human, "compensation_changed");
    expect((await events(d)).at(-1)).toEqual({
      from_status: "submitted",
      to_status: "draft",
      actor_id: a.human,
      reason: "compensation_changed",
    });
    await move(d, "submitted", a.human, "again");
    await move(d, "approved", approver, "checked");
    await move(d, "draft", approver, "figures changed");
    expect((await events(d)).at(-1)).toMatchObject({ from_status: "approved", to_status: "draft" });
  });

  it("refuses every pair the matrix does not name", async () => {
    const d = await draft(strictType, "PT");
    // Every one of these is ERR_DOC_STATUS_ILLEGAL and nothing else: the matrix of block 2a names no pair
    // starting at `draft` except `submitted` and `issued`, and it runs before R1 and R2 — so the error is
    // never an SoD one from this row, however authorised the actor is.
    for (const to of ["approved", "posted", "void", "reversed"]) {
      await expect(move(d, to, approver, "why not"), `draft → ${to}`).rejects.toThrow(
        /ERR_DOC_STATUS_ILLEGAL/,
      );
    }
    await move(d, "submitted", a.human, "for review");
    for (const to of ["posted", "void", "reversed"]) {
      await expect(move(d, to, approver, "why not")).rejects.toThrow(/ERR_DOC_STATUS_ILLEGAL/);
    }
  });

  it("posted → reversed is admitted only when a posted reversal already points at the original (D13)", async () => {
    const original = await draft(a.docType, "JV");
    await move(original, "issued", a.human);
    await move(original, "posted", a.human);
    await expect(move(original, "reversed", a.human, "by hand")).rejects.toThrow(
      /ERR_DOC_STATUS_ILLEGAL: document .* can only be marked reversed by reverseDocument/,
    );

    const mirror = await uuidv7(db.admin);
    await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      await tx`insert into app.document (id, tenant_id, company_id, document_type_id, series, effective_date, currency, branch_id, reverses_document_id)
               values (${mirror}, ${a.tenant}, ${a.company}, ${a.docType}, 'JV', '2026-01-16', 'MYR', ${a.hq}, ${original})`;
      await tx`insert into app.document_line (tenant_id, company_id, document_id, line_no, account_id, credit)
               values (${a.tenant}, ${a.company}, ${mirror}, 1, ${a.cash}, 10.0000)`;
      await tx`insert into app.document_line (tenant_id, company_id, document_id, line_no, account_id, debit)
               values (${a.tenant}, ${a.company}, ${mirror}, 2, ${a.sales}, 10.0000)`;
    });
    await move(mirror, "issued", a.human);
    await move(mirror, "posted", a.human);
    await move(original, "reversed", a.human, "corrected by JV reversal");
    expect((await events(original)).at(-1)).toMatchObject({
      from_status: "posted",
      to_status: "reversed",
    });
  });

  it("a status update that does not change the status writes no event", async () => {
    const d = await draft(a.docType, "JV");
    await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx`update app.document set status = 'draft' where id = ${d}`,
    );
    expect(await events(d)).toEqual([]);
  });

  it("a policy with no approval block fails closed on approved/posted/void (assumption 5)", async () => {
    // seedTenant's placeholder policy (version 1) has no approval member; JOURNAL_POLICY_V1 (version 2) does,
    // and resolution takes the highest version at the same effective_from — so a type with ONLY the placeholder
    // is what proves the fail-closed path. The type is POLICY_TEST_2, §4.14's second test-only code; the
    // placeholder is not schema-valid, so it is inserted as the migrator rather than through seedDocumentType.
    const bare = await uuidv7(db.admin);
    await withTenant(db.migrator, a.tenant, a.system, async (tx) => {
      await tx`insert into app.document_type (id, tenant_id, company_id, code, name_en)
               values (${bare}, ${a.tenant}, ${a.company}, 'POLICY_TEST_2', 'Bare')`;
      await tx`insert into app.posting_policy (tenant_id, document_type_id, version, effective_from, definition)
               values (${a.tenant}, ${bare}, 1, '2026-01-01', ${JSON.stringify({ version: 1, documentType: "POLICY_TEST_2", direction: "none", lines: [] })}::text::jsonb)`;
    });
    const d = await draft(bare, "PT2");
    await move(d, "issued", a.human); // no gate on → issued
    await expect(move(d, "void", a.human, "no policy")).rejects.toThrow(
      /ERR_POLICY_INVALID: the policy effective for document .* declares no approval\.post/,
    );
  });

  it("ERR_POLICY_NOT_FOUND when no policy is effective for the document's date", async () => {
    // §4.14: "a second type whose only policy version is effective AFTER the document's date" is what
    // POLICY_TEST_2 exists for — in a second tenant here, because tenant A's POLICY_TEST_2 is the case above.
    const b = await seedTenantV2(db, "Beta");
    await grantCodes(db, b);
    const late = await seedDocumentType(db, b, {
      code: "POLICY_TEST_2",
      policy: {
        ...STRICT_POLICY,
        documentType: "POLICY_TEST_2",
        numbering: { series: "PT2", assignAt: "issue" },
        reversal: { allowed: true, producesType: "POLICY_TEST_2" },
      },
      effectiveFrom: "2027-01-01",
    });
    const d = await uuidv7(db.admin);
    await withTenant(
      db.rw,
      b.tenant,
      b.human,
      (tx) => tx`
        insert into app.document (id, tenant_id, company_id, document_type_id, series, effective_date, currency, branch_id)
        values (${d}, ${b.tenant}, ${b.company}, ${late}, 'PT2', '2026-01-15', 'MYR', ${b.hq})`,
    );
    await expect(
      withTenant(db.rw, b.tenant, b.human, async (tx) => {
        await tx`select set_config('app.event_reason', 'too early', true)`;
        await tx`update app.document set status = 'submitted' where id = ${d}`;
      }),
    ).rejects.toThrow(
      /ERR_POLICY_NOT_FOUND: no posting policy of document type .* is effective on 2026-01-15/,
    );
  });
});
