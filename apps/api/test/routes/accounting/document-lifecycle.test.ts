import { afterAll, beforeAll, describe, expect, it } from "vitest";
// Two helpers, one name: the PRODUCTION withTenant takes (sql, ctx, fn) and the TEST one takes
// (sql, tenantId, actorId, fn) — contracts §4.2.2, hazard 15. Both are needed here, so the test one is
// aliased at the import rather than shadowed.
import { withTenant } from "@dulja/db";
import {
  grantCodes,
  seedTenantV2,
  uuidv7,
  withTenant as testWithTenant,
  type Seed,
} from "@dulja/db/test";
import { problemOf } from "../../../../../tests/support/api";
import { startApi, type StartedApi } from "../../support/app";

const journalBody = (s: Seed, amount: string) => ({
  documentTypeCode: "JOURNAL",
  effectiveDate: "2026-01-15",
  currency: "MYR",
  branchId: s.hq,
  lines: [
    { lineNo: 1, accountId: s.cash, debit: amount },
    { lineNo: 2, accountId: s.sales, credit: amount },
  ],
});

describe("reverse / overrides / delete / events — contracts §4.5.3, §4.5.4", () => {
  let api: StartedApi;
  let a: Seed;
  let b: Seed;
  let supervisor: string;

  const person = async (s: Seed, label: string): Promise<string> => {
    const id = await uuidv7(api.db.admin);
    await testWithTenant(api.db.migrator, s.tenant, s.system, async (tx) => {
      await tx`insert into app.principal (id, kind, auth_subject, display_name)
               values (${id}, 'human', ${`${label}:${s.tenant}`}, ${label})`;
      await tx`insert into app.membership (tenant_id, principal_id) values (${s.tenant}, ${id})`;
    });
    await api.loadPrincipals();
    return id;
  };

  /** A posted JOURNAL through the public surface, so the test never writes app.document itself. */
  const posted = async (): Promise<string> => {
    const created = await api.request({
      method: "POST",
      path: `/v1/companies/${a.company}/documents`,
      as: a.human,
      body: journalBody(a, "9.0000"),
    });
    const { id } = (await created.json()) as { id: string };
    await api.request({
      method: "POST",
      path: `/v1/companies/${a.company}/documents/${id}/transitions`,
      as: a.human,
      body: { to: "posted" },
    });
    return id;
  };

  const draft = async (): Promise<string> => {
    const created = await api.request({
      method: "POST",
      path: `/v1/companies/${a.company}/documents`,
      as: a.human,
      body: journalBody(a, "4.0000"),
    });
    return ((await created.json()) as { id: string }).id;
  };

  beforeAll(async () => {
    api = await startApi();
    a = await seedTenantV2(api.db, "Alpha");
    b = await seedTenantV2(api.db, "Beta");
    // a.human drafts, posts, reverses and reads the event log; the reverse route needs BOTH its own code and
    // the reversal type's approval.post, because reverseDocument posts the reversing document through the
    // status trigger (the pair is deliberate — 2B Task 5).
    await grantCodes(api.db, a, {
      codes: ["accounting.journal.post", "accounting.document.reverse", "accounting.ledger.read"],
    });
    await grantCodes(api.db, b, {
      codes: ["accounting.journal.post", "accounting.document.reverse"],
    });
    supervisor = await person(a, "supervisor");
    // accounting.credit_limit.override is 4A's catalogue row and does not exist at 2B. app.permission is
    // global, has no RLS and is read-only for app_rw, so this container-local row proves the mechanism
    // without touching packages/contracts/permissions.ts — exactly as the db-tier suites do.
    await api.db.migrator`insert into app.permission (code, module, mutating, description)
      values ('accounting.credit_limit.override', 'accounting', true, 'test-local stand-in for 4A''s code')
      on conflict (code) do nothing`;
    await grantCodes(api.db, a, {
      principalId: supervisor,
      codes: ["accounting.credit_limit.override"],
    });
  });
  afterAll(async () => {
    await api.stop();
  });

  it("POST …/reverse produces the reversing document and marks the original reversed (D13)", async () => {
    const id = await posted();
    const res = await api.request({
      method: "POST",
      path: `/v1/companies/${a.company}/documents/${id}/reverse`,
      as: a.human,
      body: { effectiveDate: "2026-01-20", reason: "wrong account" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { reversalDocumentId: string; number: string };
    expect(body.number).toMatch(/^\d+$/);
    const rows = await withTenant(
      api.db.rw,
      { tenantId: a.tenant, actorId: a.human, requestId: "r" },
      (tx) => tx<{ status: string }[]>`
        select status::text as status from app.document
         where id in (${id}, ${body.reversalDocumentId}) order by id = ${id} desc`,
    );
    expect(rows.map((r) => r.status)).toEqual(["reversed", "posted"]);
  });

  it("POST …/reverse admits a BRANCH-SCOPED reverser at their own branch (route decision 4, spec:2166)", async () => {
    const id = await posted(); // branch_id = a.hq
    const bm = await person(a, "branch-manager");
    // The shape R8 gives a branch manager: the codes come through an assignment WITH role_assignment_branch
    // rows, so app.actor_has(code, company, null) is FALSE for them. A company-scoped gate would refuse this
    // principal at every branch; `branch: "document"` asks about a.hq and admits them. Both codes are needed:
    // the gate authorises the reversal, the status trigger authorises the POSTING of the reversing document.
    await grantCodes(api.db, a, {
      principalId: bm,
      codes: ["accounting.document.reverse", "accounting.journal.post"],
      branchIds: [a.hq],
      roleCode: "branch-reverse",
    });
    const [companyWide] = await withTenant(
      api.db.rw,
      { tenantId: a.tenant, actorId: bm, requestId: "bm" },
      (tx) =>
        tx<
          { ok: boolean }[]
        >`select app.actor_has('accounting.document.reverse', ${a.company}) as ok`,
    );
    expect(companyWide!.ok).toBe(false); // the gap a company-scoped gate would have opened
    const res = await api.request({
      method: "POST",
      path: `/v1/companies/${a.company}/documents/${id}/reverse`,
      as: bm,
      body: { effectiveDate: "2026-01-20", reason: "wrong branch account" },
    });
    expect(res.status).toBe(200);
  });

  it("POST …/reverse is 403 for a principal without accounting.document.reverse", async () => {
    const id = await posted();
    const bystander = await person(a, "bystander");
    const res = await api.request({
      method: "POST",
      path: `/v1/companies/${a.company}/documents/${id}/reverse`,
      as: bystander,
      body: { effectiveDate: "2026-01-20", reason: "not mine" },
    });
    expect(res.status).toBe(403);
    expect((await problemOf(res)).code).toBe("ERR_RBAC_FORBIDDEN");
  });

  it("POST …/overrides admits a second principal who holds the code and refuses the creator (R8)", async () => {
    const id = await draft();
    const ok = await api.request({
      method: "POST",
      path: `/v1/companies/${a.company}/documents/${id}/overrides`,
      as: supervisor,
      body: { code: "accounting.credit_limit.override", reason: "customer is good for it" },
    });
    expect(ok.status).toBe(200);
    expect((await ok.json()) as { eventId: string }).toMatchObject({ eventId: expect.any(String) });

    await grantCodes(api.db, a, {
      codes: ["accounting.credit_limit.override"],
      roleCode: "self-override",
    });
    const refused = await api.request({
      method: "POST",
      path: `/v1/companies/${a.company}/documents/${id}/overrides`,
      as: a.human,
      body: { code: "accounting.credit_limit.override", reason: "mine" },
    });
    // The pre-flight passes (a.human now holds the code); the GUARD refuses, because a.human created the
    // document. ERRORS maps ERR_OVERRIDE_NOT_AUTHORISED to 403 (contracts §4.2.4: an authority failure).
    expect(refused.status).toBe(403);
    expect((await problemOf(refused)).code).toBe("ERR_OVERRIDE_NOT_AUTHORISED");
  });

  it("POST …/overrides is 403 before the guard runs when the caller holds no such code", async () => {
    const id = await draft();
    // A member of the company holding no code: a caller with NO role in the path company is refused on the
    // company before the document is read (S3, code review 2), and this case is about the code's pre-flight.
    const nobody = await person(a, "nobody");
    await grantCodes(api.db, a, { principalId: nobody, roleCode: "override-nobody" });
    const res = await api.request({
      method: "POST",
      path: `/v1/companies/${a.company}/documents/${id}/overrides`,
      as: nobody,
      body: { code: "accounting.credit_limit.override", reason: "passing by" },
    });
    expect(res.status).toBe(403);
    expect((await problemOf(res)).detail).toContain("accounting.credit_limit.override");
  });

  it("POST …/overrides refuses a HUMAN caller who names attributedTo — identity is never client-supplied", async () => {
    const id = await draft();
    // spec:1324 confines attributed_to to the terminal-acting POS shape. A human who could name any principal
    // holding the code would make the guard check THAT principal's authority and record an override "by" a
    // supervisor who never saw it; the same door on TransitionBody is shut the same way.
    const res = await api.request({
      method: "POST",
      path: `/v1/companies/${a.company}/documents/${id}/overrides`,
      as: a.human,
      body: {
        code: "accounting.credit_limit.override",
        reason: "on their behalf",
        attributedTo: supervisor,
      },
    });
    expect(res.status).toBe(400);
    const problem = await problemOf(res);
    expect(problem.code).toBe("ERR_VALIDATION_FAILED");
    expect(problem.errors?.map((e) => e.path)).toEqual(["attributedTo"]);
    const moved = await api.request({
      method: "POST",
      path: `/v1/companies/${a.company}/documents/${id}/transitions`,
      as: a.human,
      body: { to: "submitted", attributedTo: supervisor },
    });
    expect(moved.status).toBe(400);
    expect((await problemOf(moved)).code).toBe("ERR_VALIDATION_FAILED");
    // No event was written for either refusal.
    const [events] = await api.db.admin<{ n: number }[]>`
      select count(*)::int as n from app.document_event where document_id = ${id}`;
    expect(events!.n).toBe(0);
  });

  it("POST …/overrides from a TERMINAL names the ATTRIBUTED principal in its 403, not the terminal", async () => {
    const id = await draft();
    const unauthorised = await person(a, "unauthorised-supervisor");
    const terminal = await uuidv7(api.db.admin);
    await testWithTenant(api.db.migrator, a.tenant, a.system, async (tx) => {
      await tx`insert into app.principal (id, kind, auth_subject, display_name)
               values (${terminal}, 'terminal', ${`terminal:${terminal}`}, 'Till 1')`;
      await tx`insert into app.membership (tenant_id, principal_id) values (${a.tenant}, ${terminal})`;
    });
    // Enrolled as a terminal is (spec:2165): its pos_terminal role in the company. Without a role in the path
    // company the gate refuses on the company before it asks about anyone (S3, code review 2).
    await grantCodes(api.db, a, { principalId: terminal, roleCode: "pos_terminal" });
    await api.loadPrincipals();
    // The POS shape (hazard 19): the terminal acts and names the supervisor the override belongs to. The
    // supervisor is the one whose authority the guard checks, so the pre-flight must check the same principal
    // — a 403 naming the terminal would send an operator to reset the wrong permissions.
    const res = await api.request({
      method: "POST",
      path: `/v1/companies/${a.company}/documents/${id}/overrides`,
      as: terminal,
      body: {
        code: "accounting.credit_limit.override",
        reason: "on their behalf",
        attributedTo: unauthorised,
      },
    });
    expect(res.status).toBe(403);
    const problem = await problemOf(res);
    expect(problem.detail).toContain(unauthorised);
    expect(problem.detail).not.toContain(terminal);
  });

  it("POST …/overrides on a code no slice has seeded is refused by the data layer (F-21)", async () => {
    const id = await draft();
    await grantCodes(api.db, a, { principalId: supervisor, codes: [], roleCode: "no-codes" });
    const res = await api.request({
      method: "POST",
      path: `/v1/companies/${a.company}/documents/${id}/overrides`,
      as: supervisor,
      body: { code: "pos.ticket.override", reason: "6A's code, absent at 2B" },
    });
    // The pre-flight refuses first — nobody can hold a code app.permission does not contain — and the FK on
    // override_code is the second line of defence if a future route skips the pre-flight.
    expect([403, 409]).toContain(res.status);
    expect(["ERR_RBAC_FORBIDDEN", "ERR_CONFLICT_REFERENCE"]).toContain((await problemOf(res)).code);
  });

  it("DELETE …/{id} removes a draft and refuses an issued document (ERR_DOC_NOT_DRAFT)", async () => {
    const id = await draft();
    const gone = await api.request({
      method: "DELETE",
      path: `/v1/companies/${a.company}/documents/${id}`,
      as: a.human,
    });
    expect(gone.status).toBe(200);
    expect(await gone.json()).toEqual({ documentId: id, deleted: true });

    const issued = await draft();
    await api.request({
      method: "POST",
      path: `/v1/companies/${a.company}/documents/${issued}/transitions`,
      as: a.human,
      body: { to: "issued" },
    });
    const refused = await api.request({
      method: "DELETE",
      path: `/v1/companies/${a.company}/documents/${issued}`,
      as: a.human,
    });
    expect(refused.status).toBe(409);
    expect((await problemOf(refused)).code).toBe("ERR_DOC_NOT_DRAFT");
  });

  it("GET …/{id}/events returns the timeline oldest first, under accounting.ledger.read", async () => {
    const id = await draft();
    await api.request({
      method: "POST",
      path: `/v1/companies/${a.company}/documents/${id}/transitions`,
      as: a.human,
      body: { to: "submitted" },
    });
    await api.request({
      method: "POST",
      path: `/v1/companies/${a.company}/documents/${id}/transitions`,
      as: a.human,
      body: { to: "issued" },
    });
    const res = await api.request({
      method: "GET",
      path: `/v1/companies/${a.company}/documents/${id}/events`,
      as: a.human,
    });
    expect(res.status).toBe(200);
    const { items, next_cursor } = (await res.json()) as {
      items: { toStatus: string }[];
      next_cursor: string | null;
    };
    expect(items.map((e) => e.toStatus)).toEqual(["submitted", "issued"]);
    expect(next_cursor).toBeNull();

    const reader = await person(a, "no-ledger-read");
    const denied = await api.request({
      method: "GET",
      path: `/v1/companies/${a.company}/documents/${id}/events`,
      as: reader,
    });
    expect(denied.status).toBe(403);
  });

  it("all four routes 404 across tenants and reveal nothing (test 12; spec:106)", async () => {
    const bDoc = await api.request({
      method: "POST",
      path: `/v1/companies/${b.company}/documents`,
      as: b.human,
      body: journalBody(b, "1.0000"),
    });
    const { id } = (await bDoc.json()) as { id: string };
    const attempts = [
      {
        method: "POST",
        path: `/v1/companies/${a.company}/documents/${id}/reverse`,
        body: { effectiveDate: "2026-01-20", reason: "x" },
      },
      {
        method: "POST",
        path: `/v1/companies/${a.company}/documents/${id}/overrides`,
        body: { code: "accounting.credit_limit.override", reason: "x" },
      },
      { method: "DELETE", path: `/v1/companies/${a.company}/documents/${id}` },
      { method: "GET", path: `/v1/companies/${a.company}/documents/${id}/events` },
    ] as const;
    for (const attempt of attempts) {
      const res = await api.request({ ...attempt, as: a.human });
      expect(res.status, attempt.path).toBe(404);
      expect((await problemOf(res)).code).toBe("ERR_NOT_FOUND");
    }
    const [survived] = await withTenant(
      api.db.rw,
      { tenantId: b.tenant, actorId: b.human, requestId: "r" },
      (tx) => tx<{ n: number }[]>`select count(*)::int as n from app.document where id = ${id}`,
    );
    expect(survived!.n).toBe(1);
  });
});
