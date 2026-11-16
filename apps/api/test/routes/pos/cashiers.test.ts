import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startApi, type StartedApi } from "../../support/app";
import { StubAuthAdmin } from "../../../src/auth-admin";
import {
  seedTenantV2,
  seedTenant,
  seedBranch,
  seedEmployee,
  seedCashier,
  grantCodes,
  uuidv7,
  withTenant,
  type Seed,
} from "@dulja/db/test";
import { verifyPin } from "@dulja/db";
import { CashierSchema } from "@dulja/contracts/pos/cashier";
import { encodeCursor } from "@dulja/contracts";
import { grantAdmin, problemOf } from "../../../../../tests/support/api";
let api: StartedApi, s: Seed, branchB: string;
let creates = 0;
const provider = new StubAuthAdmin();
beforeAll(async () => {
  api = await startApi({
    authAdmin: {
      inviteUser: (email) => provider.inviteUser(email),
      createUser: (email) => {
        creates++;
        return provider.createUser(email);
      },
    },
  });
  s = await seedTenantV2(api.db, "CASHIER-API");
  branchB = await seedBranch(api.db, s, { code: "CASH-B" });
  await grantAdmin(api, s);
  await grantCodes(api.db, s, { codes: ["pos.cashier.manage_pin", "hr.employee.read"] });
}, 180_000);
afterAll(async () => api.stop());
const path = () => `/v1/companies/${s.company}/cashiers`;
async function employee(number: string, homeBranchId = s.hq) {
  return seedEmployee(api.db, s, { employeeNumber: number, homeBranchId });
}
async function create(employeeId: string, branchId = s.hq, as = s.human, key?: string) {
  return api.request({
    method: "POST",
    path: path(),
    as,
    ...(key ? { idempotencyKey: key } : {}),
    body: {
      employeeId,
      branchId,
      displayName: "Cashier",
      pin: "4321",
      email: `cashier-${employeeId}@example.invalid`,
    },
  });
}
async function manager(branchId: string) {
  const id = await uuidv7(api.db.admin);
  await withTenant(api.db.migrator, s.tenant, s.system, async (tx) => {
    await tx`insert into app.principal(id,kind,auth_subject,display_name) values (${id},'human',${"manager-" + id},'Manager')`;
    await tx`insert into app.membership(tenant_id,principal_id) values (${s.tenant},${id})`;
  });
  await grantCodes(api.db, s, {
    codes: ["pos.cashier.manage_pin", "hr.employee.read"],
    principalId: id,
    branchIds: [branchId],
  });
  return id;
}
describe("cashier onboarding and PIN management", () => {
  it("creates a provider-bound human, membership, employee link and closed snapshot without assigning a role", async () => {
    const e = await employee("C-1"),
      before = creates;
    const res = await create(e);
    expect(res.status).toBe(201);
    const row = CashierSchema.parse(await res.json());
    expect(creates).toBe(before + 1);
    expect(row).toMatchObject({
      employeeId: e,
      employeeNumber: "C-1",
      branchId: s.hq,
      revokedAt: null,
    });
    expect(row.snapshot.codes).toEqual([]);
    expect(Object.keys(row.snapshot.limits)).toHaveLength(9);
    expect(row.snapshot.revision).toBe(row.revision);
    const [p] = await api.db.admin<
      { auth_subject: string; tenant_id: string; principal_id: string }[]
    >`select p.auth_subject,m.tenant_id,e.principal_id from app.principal p join app.membership m on m.principal_id=p.id join app.employee e on e.principal_id=p.id where p.id=${row.principalId}`;
    expect(p).toMatchObject({ tenant_id: s.tenant, principal_id: row.principalId });
    expect(p!.auth_subject).toBe((await provider.createUser(`cashier-${e}@example.invalid`)).sub);
    expect(api.invitesSent()).toBe(0);
  });
  it("stores only a PHC hash and never emits PIN/hash in responses or logs", async () => {
    const e = await employee("C-2"),
      res = await create(e);
    expect(res.status).toBe(201);
    const text = await res.text();
    expect(text).not.toContain("4321");
    expect(text).not.toMatch(/pinHash|pin_hash|argon2/);
    const [row] = await api.db.admin<
      { pin_hash: string }[]
    >`select pin_hash from app.pos_cashier where employee_id=${e}`;
    expect(row!.pin_hash).toMatch(/^\$argon2id\$/);
    expect(await verifyPin("4321", row!.pin_hash)).toBe(true);
    expect(JSON.stringify(api.takeLogs())).not.toContain("4321");
  });
  it("validates PIN and employee/branch facts before creating any provider user", async () => {
    const e = await employee("C-3"),
      foreign = await seedTenant(api.db, "CASH-OTHER"),
      foreignE = await seedEmployee(api.db, foreign);
    const before = creates;
    const badPin = await api.request({
      method: "POST",
      path: path(),
      as: s.human,
      body: {
        employeeId: e,
        branchId: s.hq,
        displayName: "Cashier",
        email: "bad@example.invalid",
        pin: "1",
      },
    });
    expect(badPin.status).toBe(400);
    expect((await problemOf(badPin)).code).toBe("ERR_VALIDATION_FAILED");
    for (const [employeeId, branchId] of [
      [foreignE, s.hq],
      [e, foreign.hq],
      [crypto.randomUUID(), s.hq],
    ]) {
      const res = await create(employeeId!, branchId!);
      expect(res.status).toBe(404);
    }
    expect(creates).toBe(before);
  });
  it("replays the same idempotency key without creating the user twice and rejects a linked employee before provider access", async () => {
    const e = await employee("C-4"),
      key = crypto.randomUUID(),
      before = creates;
    const first = await create(e, s.hq, s.human, key),
      second = await create(e, s.hq, s.human, key);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(await second.json()).toEqual(await first.json());
    expect(creates).toBe(before + 1);
    expect((await create(e)).status).toBe(409);
    expect(creates).toBe(before + 1);
  });
  it("serializes concurrent onboarding of one employee before the provider side effect", async () => {
    const e = await employee("C-CONCURRENT"),
      before = creates;
    const results = await Promise.all([create(e), create(e)]);
    expect(results.map((r) => r.status).toSorted()).toEqual([201, 409]);
    expect(creates).toBe(before + 1);
  });
  it("a branch-only manager identifies a home-B/credential-A cashier and resets its PIN while the home directory stays hidden", async () => {
    const e = await employee("C-HOME-B", branchB),
      created = await create(e),
      row = CashierSchema.parse(await created.json()),
      mgr = await manager(s.hq);
    const directory = await api.request({
      method: "GET",
      path: `/v1/companies/${s.company}/employees/${e}`,
      as: mgr,
    });
    expect(directory.status).toBe(404);
    const listed = await api.request({
      method: "GET",
      path: `${path()}?filter[branchId][eq]=${s.hq}`,
      as: mgr,
    });
    expect(listed.status).toBe(200);
    expect(((await listed.json()) as { items: unknown[] }).items).toContainEqual(
      expect.objectContaining({ principalId: row.principalId, employeeNumber: "C-HOME-B" }),
    );
    const reset = await api.request({
      method: "POST",
      path: `${path()}/${row.principalId}/pin`,
      as: mgr,
      body: { pin: "778899" },
    });
    expect(reset.status).toBe(200);
    const [stored] = await api.db.admin<
      { pin_hash: string }[]
    >`select pin_hash from app.pos_cashier where principal_id=${row.principalId}`;
    expect(await verifyPin("778899", stored!.pin_hash)).toBe(true);
    expect(await verifyPin("4321", stored!.pin_hash)).toBe(false);
  });
  it("other-branch manager GET/reset returns 404 and cannot create/revoke principals", async () => {
    const e = await employee("C-5"),
      row = CashierSchema.parse(await (await create(e)).json()),
      mgr = await manager(branchB);
    for (const method of ["GET", "POST"] as const) {
      const res = await api.request({
        method,
        path: `${path()}/${row.principalId}${method === "POST" ? "/pin" : ""}`,
        as: mgr,
        ...(method === "POST" ? { body: { pin: "112233" } } : {}),
      });
      expect(res.status).toBe(404);
      expect((await problemOf(res)).code).toBe("ERR_NOT_FOUND");
    }
    expect((await create(await employee("C-NO-CREATE"), branchB, mgr)).status).toBe(403);
    expect(
      (
        await api.request({
          method: "POST",
          path: `${path()}/${row.principalId}/revoke`,
          as: mgr,
          body: {},
        })
      ).status,
    ).toBe(403);
  });
  it("a blank assignment at B grants no PIN-directory authority there", async () => {
    const e = await employee("C-B-NO-CODE", branchB);
    const created = await create(e, branchB);
    expect(created.status).toBe(201);
    const row = CashierSchema.parse(await created.json());
    const mgr = await manager(s.hq);
    await grantCodes(api.db, s, { principalId: mgr, branchIds: [branchB] });
    const listed = await api.request({
      method: "GET",
      path: `${path()}?limit=1&filter[branchId][eq]=${branchB}`,
      as: mgr,
    });
    expect(listed.status).toBe(200);
    expect(await listed.json()).toMatchObject({ items: [], next_cursor: null });
    const directory = await api.request({
      method: "GET",
      path: `/v1/companies/${s.company}/employees?filter[homeBranchId][eq]=${branchB}`,
      as: mgr,
    });
    expect(directory.status).toBe(200);
    expect(await directory.json()).toMatchObject({ items: [], next_cursor: null });
    const reset = await api.request({
      method: "POST",
      path: `${path()}/${row.principalId}/pin`,
      as: mgr,
      body: { pin: "667788" },
    });
    expect(reset.status).toBe(403);
    const [stored] = await api.db.admin<
      { pin_hash: string }[]
    >`select pin_hash from app.pos_cashier where principal_id=${row.principalId}`;
    expect(await verifyPin("4321", stored!.pin_hash)).toBe(true);
  });
  it("revocation is idempotent, clears codes and emits exactly one tombstone", async () => {
    const row = CashierSchema.parse(await (await create(await employee("C-6"))).json());
    for (let i = 0; i < 2; i++) {
      const res = await api.request({
        method: "POST",
        path: `${path()}/${row.principalId}/revoke`,
        as: s.human,
        body: {},
      });
      expect(res.status).toBe(200);
      expect(CashierSchema.parse(await res.json())).toMatchObject({
        employeeNumber: null,
        snapshot: { codes: [] },
      });
    }
    const [n] = await api.db.admin<
      { n: number }[]
    >`select count(*)::int n from app.catalogue_tombstone where stream='cashier' and row_id=${row.principalId}`;
    expect(n!.n).toBe(1);
  });
  it("binds same-tenant other-company cashier IDs for GET/PIN/revoke", async () => {
    const company = await uuidv7(api.db.admin),
      type = await uuidv7(api.db.admin),
      home = await uuidv7(api.db.admin);
    await withTenant(api.db.migrator, s.tenant, s.system, async (tx) => {
      await tx`insert into app.company(id,tenant_id,code,name,base_currency) values (${company},${s.tenant},'CASH-SECOND','Second','MYR')`;
      await tx`insert into app.dimension_type(id,tenant_id,company_id,code,name_en) values (${type},${s.tenant},${company},'BRANCH','Branch')`;
      await tx`insert into app.dimension_value(id,tenant_id,dimension_type_id,code,name_en) values (${home},${s.tenant},${type},'HQ','HQ')`;
    });
    const other = { ...s, company, hq: home },
      e = await seedEmployee(api.db, other),
      principalId = await seedCashier(api.db, other, { employeeId: e, branchId: home });
    await grantCodes(api.db, other, { codes: ["pos.cashier.manage_pin", "admin.user.manage"] });
    for (const suffix of ["", "/pin", "/revoke"]) {
      const res = await api.request({
        method: suffix ? "POST" : "GET",
        path: `${path()}/${principalId}${suffix}`,
        as: s.human,
        ...(suffix ? { body: suffix === "/pin" ? { pin: "556677" } : {} } : {}),
      });
      expect(res.status).toBe(404);
    }
    const before = creates;
    expect((await create(e)).status).toBe(404);
    expect(creates).toBe(before);
  });
  it("pages exact IDs once and refuses malformed cursors", async () => {
    const first = await api.request({ method: "GET", path: `${path()}?limit=1`, as: s.human });
    expect(first.status).toBe(200);
    const page = (await first.json()) as { items: { principalId: string }[]; next_cursor: string };
    const second = await api.request({
      method: "GET",
      path: `${path()}?limit=1&cursor=${encodeURIComponent(page.next_cursor)}`,
      as: s.human,
    });
    expect(second.status).toBe(200);
    expect(
      ((await second.json()) as { items: { principalId: string }[] }).items[0]!.principalId,
    ).not.toBe(page.items[0]!.principalId);
    const bad = await api.request({
      method: "GET",
      path: `${path()}?cursor=${encodeURIComponent(encodeCursor({ k: [], id: "invalid" }))}`,
      as: s.human,
    });
    expect(bad.status).toBe(400);
  });
});
