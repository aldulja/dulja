import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  grantCodes,
  seedAccount,
  seedPaymentTerm,
  seedPriceList,
  seedTenantV2,
  uuidv7,
  type Seed,
} from "@dulja/db/test";
import { problemOf } from "../../../../../tests/support/api";
import { secondPrincipal } from "../../../../../tests/invariants/support/post-inventory";
import { startApi, type StartedApi } from "../../support/app";

describe("/v1/companies/{companyId}/parties — spec:1169, contracts §4.5.7", () => {
  let api: StartedApi;
  let a: Seed;
  let receivable: string;
  const base = () => `/v1/companies/${a.company}/parties`;

  /** `accounting.party.manage` is what these routes gate on (T4 seeds it to `user`); `grantAdmin` grants the
   *  five admin codes and nothing else, so the grant is made here through a real role chain. */
  const grantPartyManage = async (s: Seed, principalId: string): Promise<void> => {
    const roleId = await uuidv7(api.db.admin);
    await api.db.migrator.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${s.tenant}, true), set_config('app.actor_id', ${s.system}, true)`;
      await tx`insert into app.role (id, tenant_id, code, name_en)
               values (${roleId}, ${s.tenant}, ${`r-${roleId.slice(-12)}`}, 'party clerk')`;
      await tx`insert into app.role_permission (tenant_id, role_id, permission_code)
               values (${s.tenant}, ${roleId}, 'accounting.party.manage')`;
      await tx`insert into app.role_assignment (tenant_id, principal_id, role_id, company_id)
               values (${s.tenant}, ${principalId}, ${roleId}, ${s.company})`;
    });
  };

  beforeAll(async () => {
    api = await startApi();
    a = await seedTenantV2(api.db, "Alpha");
    await grantPartyManage(a, a.human);
    receivable = await seedAccount(api.db, a, {
      code: "1200",
      nameEn: "Trade receivables",
      type: "asset",
    });
  });
  afterAll(async () => {
    await api.stop();
  });

  const create = (over: Record<string, unknown> = {}) =>
    api.request({
      method: "POST",
      path: base(),
      as: a.human,
      body: {
        kind: "customer",
        code: "C-001",
        nameEn: "Kedai Runcit Ali",
        nameAr: "دكان علي",
        receivableAccountId: receivable,
        ...over,
      },
    });

  it("creates a customer and returns it with archivedAt null", async () => {
    const res = await create();
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      kind: "customer",
      code: "C-001",
      nameEn: "Kedai Runcit Ali",
      nameAr: "دكان علي",
      archivedAt: null,
    });
  });

  it("accepts the five kinds spec:1169 names and refuses a sixth", async () => {
    for (const kind of ["customer", "vendor", "employee", "student", "dealer"]) {
      expect((await create({ kind, code: `K-${kind}` })).status).toBe(201);
    }
    expect((await problemOf(await create({ kind: "supplier", code: "K-x" }))).code).toBe(
      "ERR_VALIDATION_FAILED",
    );
  });

  it("refuses a duplicate code in the company", async () => {
    // The first call is a 201 whose body is a PartySchema DTO, not a problem+json document — `problemOf` on
    // it would read `status` off a party and compare `undefined` to 201.
    expect((await create({ code: "DUP" })).status).toBe(201);
    expect((await problemOf(await create({ code: "DUP" }))).code).toBe("ERR_CONFLICT_UNIQUE");
  });

  it("refuses a receivable account belonging to another tenant with 404 — the row is invisible, not confirmed", async () => {
    // §4.5.7's key is `(tenant_id, receivable_account_id) → app.account(tenant_id, id)`, tenant-composite
    // only. The route checks the account BEFORE the insert, so another tenant's account is simply not found
    // under RLS (404), and the composite FK behind it (ERR_CONFLICT_REFERENCE) is the second line of defence.
    const b = await seedTenantV2(api.db, "Beta");
    const foreign = await seedAccount(api.db, b, {
      code: "1200",
      nameEn: "Trade receivables",
      type: "asset",
    });
    const res = await create({ code: "XA", receivableAccountId: foreign });
    expect(res.status).toBe(404);
    expect((await problemOf(res)).code).toBe("ERR_NOT_FOUND");
  });

  it("refuses an account of a SIBLING company in the same tenant — the schema alone would accept it", async () => {
    // The composite FK cannot tell two companies of one tenant apart, so a party of company A pointing at
    // company B's receivable account would book A's receivables into B's ledger on every later posting
    // (AGENTS.md: an entity id alone must never reach another company's rows).
    const sibling = await uuidv7(api.db.admin);
    const other = await uuidv7(api.db.admin);
    await api.db.migrator.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${a.tenant}, true), set_config('app.actor_id', ${a.system}, true)`;
      await tx`insert into app.company (id, tenant_id, code, name, base_currency)
               values (${sibling}, ${a.tenant}, 'ALPHA2', 'Alpha Two', 'MYR')`;
      await tx`insert into app.account (id, tenant_id, company_id, code, name_en, type)
               values (${other}, ${a.tenant}, ${sibling}, '1200', 'Sibling receivables', 'asset'::app.account_type)`;
    });
    const res = await create({ code: "XS", receivableAccountId: other });
    expect(res.status).toBe(404);
    expect((await problemOf(res)).code).toBe("ERR_NOT_FOUND");
  });

  it("refuses a group account and an archived account — neither takes a posting", async () => {
    const group = await seedAccount(api.db, a, {
      code: "1",
      nameEn: "Assets",
      type: "asset",
      isGroup: true,
    });
    const grouped = await create({ code: "XG", payableAccountId: group });
    expect(grouped.status).toBe(400);
    const problem = await problemOf(grouped);
    expect(problem.code).toBe("ERR_VALIDATION_FAILED");
    expect(problem.errors?.map((e) => e.path)).toEqual(["payableAccountId"]);

    const archived = await seedAccount(api.db, a, {
      code: "1290",
      nameEn: "Old receivables",
      type: "asset",
    });
    // With a tenant set: the update fires the audit trigger, whose insert into app.audit_log is under
    // forced RLS, so even the admin connection is refused without `app.tenant_id`.
    await api.db.admin.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${a.tenant}, true), set_config('app.actor_id', ${a.system}, true)`;
      await tx`update app.account set archived_at = now() where id = ${archived}`;
    });
    const gone = await create({ code: "XR", receivableAccountId: archived });
    expect(gone.status).toBe(400);
    expect((await problemOf(gone)).errors?.map((e) => e.path)).toEqual(["receivableAccountId"]);

    // PATCH runs the same check.
    const ok = await create({ code: "XP" });
    const { id } = (await ok.json()) as { id: string };
    const patched = await api.request({
      method: "PATCH",
      path: `/v1/companies/${a.company}/parties/${id}`,
      as: a.human,
      body: { receivableAccountId: group },
    });
    expect(patched.status).toBe(400);
  });

  it("lists, filters by kind and pages with the shared cursor codec", async () => {
    const first = await api.request({
      method: "GET",
      path: `${base()}?filter[kind][eq]=customer&limit=2`,
      as: a.human,
    });
    const page = (await first.json()) as {
      items: { kind: string; code: string }[];
      next_cursor: string | null;
    };
    expect(page.items.every((i) => i.kind === "customer")).toBe(true);
    expect(page.items).toHaveLength(2);
    const second = await api.request({
      method: "GET",
      path: `${base()}?filter[kind][eq]=customer&limit=2&cursor=${page.next_cursor}`,
      as: a.human,
    });
    const next = (await second.json()) as { items: { code: string }[] };
    expect(next.items.map((i) => i.code)).not.toContain(page.items[0]!.code);
  });

  it("updates the editable fields and leaves code and kind alone", async () => {
    const { id } = (await (await create({ code: "UPD" })).json()) as { id: string };
    const res = await api.request({
      method: "PATCH",
      path: `${base()}/${id}`,
      as: a.human,
      body: { nameEn: "Renamed", phone: "+60-3-0000000" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      nameEn: "Renamed",
      phone: "+60-3-0000000",
      code: "UPD",
      kind: "customer",
    });
    const rejected = await api.request({
      method: "PATCH",
      path: `${base()}/${id}`,
      as: a.human,
      body: { code: "OTHER" },
    });
    expect((await problemOf(rejected)).code).toBe("ERR_VALIDATION_FAILED");
  });

  it("archives rather than deletes, and an archived party is out of the default list (spec:2049)", async () => {
    const { id } = (await (await create({ code: "ARC" })).json()) as { id: string };
    const res = await api.request({
      method: "POST",
      path: `${base()}/${id}/archive`,
      as: a.human,
      body: {},
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { archivedAt: string | null }).archivedAt).not.toBeNull();
    const list = await api.request({ method: "GET", path: `${base()}?limit=1000`, as: a.human });
    expect(
      ((await list.json()) as { items: { code: string }[] }).items.map((i) => i.code),
    ).not.toContain("ARC");
    const deleted = await api.request({ method: "DELETE", path: `${base()}/${id}`, as: a.human });
    expect(deleted.status).toBe(404); // there is no DELETE route at all
  });

  it("a principal without accounting.party.manage is refused", async () => {
    const b = await seedTenantV2(api.db, "Beta2");
    const res = await api.request({
      method: "POST",
      path: `/v1/companies/${b.company}/parties`,
      as: b.human,
      body: { kind: "customer", code: "NOPE", nameEn: "Nope" },
    });
    expect(res.status).toBe(403);
    expect((await problemOf(res)).code).toBe("ERR_RBAC_FORBIDDEN");
  });

  it("4A — creditLimit is refused for a principal without accounting.credit_limit.override", async () => {
    // `a.human` holds only accounting.party.manage in this suite, so the negative direction needs no
    // narrower principal of its own — but the plan's shape is kept: 3D's `secondPrincipal` plus a role
    // holding ONLY accounting.party.manage is the clerk spec:2158 describes.
    const clerk = await secondPrincipal(api.db, a, "party-clerk");
    await grantCodes(api.db, a, {
      codes: ["accounting.party.manage"],
      principalId: clerk,
      roleCode: "party-clerk",
    });
    const created = await api.request({
      method: "POST",
      path: base(),
      as: clerk,
      body: { code: "CL-1", nameEn: "Clerk customer", kind: "customer" },
    });
    expect(created.status).toBe(201);
    const { id, creditLimit, creditHold } = (await created.json()) as {
      id: string;
      creditLimit: unknown;
      creditHold: boolean;
    };
    expect({ creditLimit, creditHold }).toEqual({ creditLimit: null, creditHold: false });
    // credit_hold IS allowed — spec:2158 gives the clerk credit terms…
    const hold = await api.request({
      method: "PATCH",
      path: `${base()}/${id}`,
      as: clerk,
      body: { creditHold: true },
    });
    expect(hold.status).toBe(200);
    expect(((await hold.json()) as { creditHold: boolean }).creditHold).toBe(true);
    // …and credit_limit is NOT, with a message that names the field — on create as on edit.
    const limit = await api.request({
      method: "PATCH",
      path: `${base()}/${id}`,
      as: clerk,
      body: { creditLimit: { amount: "5000.0000", currency: "MYR" } },
    });
    const problem = await problemOf(limit);
    expect(problem.code).toBe("ERR_RBAC_FORBIDDEN");
    expect(problem.detail).toMatch(/creditLimit/);
    const createdWithLimit = await api.request({
      method: "POST",
      path: base(),
      as: clerk,
      body: {
        code: "CL-2",
        nameEn: "Clerk customer 2",
        kind: "customer",
        creditLimit: { amount: "1.0000", currency: "MYR" },
      },
    });
    expect((await problemOf(createdWithLimit)).code).toBe("ERR_RBAC_FORBIDDEN");
    // Clearing a limit is the widest limit there is, so null is asked about too.
    const cleared = await api.request({
      method: "PATCH",
      path: `${base()}/${id}`,
      as: clerk,
      body: { creditLimit: null },
    });
    expect((await problemOf(cleared)).code).toBe("ERR_RBAC_FORBIDDEN");
    // The same request from a principal that holds the override code succeeds, and the limit is returned
    // in the company's base currency.
    await grantCodes(api.db, a, { codes: ["accounting.credit_limit.override"] });
    const allowed = await api.request({
      method: "PATCH",
      path: `${base()}/${id}`,
      as: a.human,
      body: { creditLimit: { amount: "5000.0000", currency: "MYR" } },
    });
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toMatchObject({
      creditLimit: { amount: "5000.0000", currency: "MYR" },
      creditHold: true,
    });
  });

  it("4A — the terms a party names belong to THIS company, and null clears them", async () => {
    // Runs after the case above granted `a.human` accounting.credit_limit.override.
    const { id } = (await (await create({ code: "TERMS" })).json()) as { id: string };
    const patch = (body: Record<string, unknown>) =>
      api.request({ method: "PATCH", path: `${base()}/${id}`, as: a.human, body });

    // A limit in any currency but the company's base is refused, never relabelled (SAH-014).
    const foreignCurrency = await patch({ creditLimit: { amount: "10.0000", currency: "USD" } });
    expect(foreignCurrency.status).toBe(400);
    expect((await problemOf(foreignCurrency)).errors?.map((e) => e.path)).toEqual([
      "creditLimit.currency",
    ]);
    // A negative limit is a 400 from the schema, not a 500 from party_credit_limit_check.
    const negative = await patch({ creditLimit: { amount: "-1.0000", currency: "MYR" } });
    expect((await problemOf(negative)).code).toBe("ERR_VALIDATION_FAILED");

    // A sibling company's payment term is invisible here: the composite FK alone would admit it.
    const sibling = await uuidv7(api.db.admin);
    await api.db.migrator.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${a.tenant}, true), set_config('app.actor_id', ${a.system}, true)`;
      await tx`insert into app.company (id, tenant_id, code, name, base_currency)
               values (${sibling}, ${a.tenant}, 'ALPHA3', 'Alpha Three', 'MYR')`;
    });
    const siblingTerm = await seedPaymentTerm(
      api.db,
      { ...a, company: sibling },
      { code: "SIB30" },
    );
    const foreignTerm = await patch({ paymentTermId: siblingTerm });
    expect(foreignTerm.status).toBe(404);
    expect((await problemOf(foreignTerm)).code).toBe("ERR_NOT_FOUND");

    const termId = await seedPaymentTerm(api.db, a, { code: "NET45", dueDays: 45 });
    const listId = await seedPriceList(api.db, a, { code: "WHOLESALE", currency: "MYR" });
    const set = await patch({
      creditLimit: { amount: "750.0000", currency: "MYR" },
      paymentTermId: termId,
      priceListId: listId,
    });
    expect(set.status).toBe(200);
    const read = await api.request({ method: "GET", path: `${base()}/${id}`, as: a.human });
    expect(await read.json()).toMatchObject({
      creditLimit: { amount: "750.0000", currency: "MYR" },
      paymentTermId: termId,
      priceListId: listId,
      creditHold: false,
    });
    // An absent field is kept; null clears it.
    const kept = await patch({ nameEn: "Terms customer" });
    expect(await kept.json()).toMatchObject({ paymentTermId: termId, priceListId: listId });
    const clear = await patch({ creditLimit: null, paymentTermId: null, priceListId: null });
    expect(await clear.json()).toMatchObject({
      creditLimit: null,
      paymentTermId: null,
      priceListId: null,
    });
  });

  it("every unsafe call needs an Idempotency-Key, and a replay returns the first response", async () => {
    const missing = await api.request({
      method: "POST",
      path: base(),
      as: a.human,
      idempotencyKey: null,
      body: { kind: "vendor", code: "IDEM", nameEn: "Idem" },
    });
    expect((await problemOf(missing)).code).toBe("ERR_IDEMPOTENCY_KEY_MISSING");
    const key = "party-idem-1";
    const one = await api.request({
      method: "POST",
      path: base(),
      as: a.human,
      idempotencyKey: key,
      body: { kind: "vendor", code: "IDEM", nameEn: "Idem" },
    });
    const two = await api.request({
      method: "POST",
      path: base(),
      as: a.human,
      idempotencyKey: key,
      body: { kind: "vendor", code: "IDEM", nameEn: "Idem" },
    });
    expect(one.status).toBe(201);
    expect(two.status).toBe(201);
    expect(two.headers.get("Idempotency-Replayed")).toBe("true");
  });
});
