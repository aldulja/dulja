import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedTenantV2, type Seed } from "@dulja/db/test";
import { grantAdmin, problemOf } from "../../../../../tests/support/api";
import { startApi, type StartedApi } from "../../support/app";

describe("/v1/companies/{companyId}/document-types — contracts §4.3.7, spec:2288", () => {
  let api: StartedApi;
  let a: Seed;
  const base = () => `/v1/companies/${a.company}/document-types`;

  const POLICY = {
    version: 1,
    documentType: "CONSIGNMENT_RETURN",
    direction: "inbound",
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
    numbering: { series: "CR", assignAt: "issue" },
    reversal: { allowed: true, producesType: "CONSIGNMENT_RETURN" },
    approval: { required: false, approve: null, post: "accounting.journal.post" },
    fxRoundingAccount: { from: "company.fx_rounding_account_id" },
  };

  beforeAll(async () => {
    api = await startApi();
    a = await seedTenantV2(api.db, "Alpha");
    await grantAdmin(api, a);
  });
  afterAll(async () => {
    await api.stop();
  });

  const createType = (over: Record<string, unknown> = {}) =>
    api.request({
      method: "POST",
      path: base(),
      as: a.human,
      body: {
        code: "CONSIGNMENT_RETURN",
        nameEn: "Consignment return",
        nameAr: "مرتجع أمانة",
        module: "accounting",
        ...over,
      },
    });

  const typeIdOf = async (code: string): Promise<string> => {
    const res = await api.request({
      method: "GET",
      path: `${base()}?filter[code][eq]=${code}`,
      as: a.human,
    });
    return ((await res.json()) as { items: { id: string }[] }).items[0]!.id;
  };

  it("creates a type with its module and returns it", async () => {
    const res = await createType();
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      code: "CONSIGNMENT_RETURN",
      module: "accounting",
      archivedAt: null,
    });
  });

  it("refuses a second type with the same code in the company", async () => {
    expect((await problemOf(await createType())).code).toBe("ERR_CONFLICT_UNIQUE");
  });

  it("refuses a module outside the four the attachment gate knows", async () => {
    // `X1` never reaches app.document_type: Zod refuses the body on `module` before the handler runs, so no
    // code enters §4.14's namespace here (hazard 32 governs codes that are *written*, and none is).
    expect((await problemOf(await createType({ code: "X1", module: "admin" }))).code).toBe(
      "ERR_VALIDATION_FAILED",
    );
  });

  it("adds a policy version and returns it with its effective_from", async () => {
    const id = await typeIdOf("CONSIGNMENT_RETURN");
    const res = await api.request({
      method: "POST",
      path: `${base()}/${id}/policies`,
      as: a.human,
      body: { version: 1, effectiveFrom: "2026-01-01", definition: POLICY },
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ version: 1, effectiveFrom: "2026-01-01" });
  });

  it("refuses a definition that fails the schema, naming the path (ERR_POLICY_INVALID)", async () => {
    const id = await typeIdOf("CONSIGNMENT_RETURN");
    const res = await api.request({
      method: "POST",
      path: `${base()}/${id}/policies`,
      as: a.human,
      body: {
        version: 2,
        effectiveFrom: "2026-02-01",
        definition: { ...POLICY, inventory: { effect: "issue" } },
      },
    });
    const problem = await problemOf(res);
    expect(problem.code).toBe("ERR_POLICY_INVALID");
    expect(problem.errors!.map((e) => e.path)).toContain("/inventory");
  });

  it("refuses a definition naming a permission code no slice has shipped (F-21)", async () => {
    const id = await typeIdOf("CONSIGNMENT_RETURN");
    const res = await api.request({
      method: "POST",
      path: `${base()}/${id}/policies`,
      as: a.human,
      body: {
        version: 2,
        effectiveFrom: "2026-02-01",
        // `hr.leave.accrue`: a well-formed hr code that no slice ships and none will — spec:2085 builds the leave
        // register with "no accrual engine". 2C wrote 3C's `inventory.receipt.post` here, later edits 8B's
        // `hr.payroll.post`, 8C's `hr.payroll.pay` and 8D's `hr.filing.generate` and `hr.leave.approve`; each was a
        // real v1 code its slice then shipped (8D Task 8's migration 0096 shipped the last, ⚠️ OD-13 answered build),
        // so the definition was accepted and the append-only case below listed two versions. With §3.6.2's whole v1
        // catalogue now in the tree, the case names a code outside it, which is the F-21 rule itself: a definition
        // may not name a code the catalogue lacks (contracts round 19, 8D A13 item 7).
        definition: {
          ...POLICY,
          approval: { required: false, approve: null, post: "hr.leave.accrue" },
        },
      },
    });
    const problem = await problemOf(res);
    expect(problem.code).toBe("ERR_POLICY_INVALID");
    expect(problem.detail).toMatch(/hr\.leave\.accrue/);
  });

  it("a version is append-only — the same version number is a conflict, never an overwrite (ADR 0027)", async () => {
    const id = await typeIdOf("CONSIGNMENT_RETURN");
    const res = await api.request({
      method: "POST",
      path: `${base()}/${id}/policies`,
      as: a.human,
      body: { version: 1, effectiveFrom: "2026-03-01", definition: POLICY },
    });
    expect((await problemOf(res)).code).toBe("ERR_CONFLICT_UNIQUE");
    const list = await api.request({
      method: "GET",
      path: `${base()}/${id}/policies`,
      as: a.human,
    });
    const page = (await list.json()) as {
      items: { version: number; effectiveFrom: string }[];
      next_cursor: string | null;
    };
    expect(page.items).toEqual(
      [{ version: 1, effectiveFrom: "2026-01-01" }].map((x) => expect.objectContaining(x)),
    );
    // One row under the default limit of 100, so the page is complete and the cursor is null — not the
    // unconditional `null` a truncating handler would also return.
    expect(page.next_cursor).toBeNull();
  });

  it("the types list pages with the shared cursor codec rather than truncating (§4.2.8)", async () => {
    const one = await api.request({ method: "GET", path: `${base()}?limit=1`, as: a.human });
    const first = (await one.json()) as { items: { code: string }[]; next_cursor: string | null };
    expect(first.items).toHaveLength(1);
    expect(first.next_cursor).not.toBeNull(); // there is more than one type in this company
    const two = await api.request({
      method: "GET",
      path: `${base()}?limit=1&cursor=${first.next_cursor}`,
      as: a.human,
    });
    const second = (await two.json()) as { items: { code: string }[] };
    expect(second.items).toHaveLength(1);
    expect(second.items[0]!.code).not.toBe(first.items[0]!.code); // (code, id) advanced; nothing repeats
  });

  it("archiving is an update, and an archived type is not offered for a new document", async () => {
    // POLICY_TEST_2 is §4.14's second test-only code (amendment A1). A second code is needed because the
    // cases above must keep CONSIGNMENT_RETURN unarchived, and hazard 32 forbids inventing one.
    const created = await createType({ code: "POLICY_TEST_2", nameEn: "Archive me" });
    const { id } = (await created.json()) as { id: string };
    const res = await api.request({
      method: "POST",
      path: `${base()}/${id}/archive`,
      as: a.human,
      body: {},
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { archivedAt: string | null }).archivedAt).not.toBeNull();
    const list = await api.request({ method: "GET", path: base(), as: a.human });
    expect(
      ((await list.json()) as { items: { code: string }[] }).items.map((i) => i.code),
    ).not.toContain("POLICY_TEST_2");
  });

  it("a principal without admin.company.manage is refused", async () => {
    const b = await seedTenantV2(api.db, "Beta"); // no grantAdmin
    const res = await api.request({
      method: "POST",
      path: `/v1/companies/${b.company}/document-types`,
      as: b.human,
      body: { code: "NOPE", nameEn: "Nope", module: "accounting" },
    });
    expect(res.status).toBe(403);
  });
});
