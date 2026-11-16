import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Problem } from "@dulja/contracts";
import { seedTenant, uuidv7, withTenant, type Seed } from "@dulja/db/test";
import { startApi, type StartedApi } from "../../support/app";

interface Entry {
  seq: string;
  actorId: string;
  occurredAt: string;
  tableName: string;
  rowId: string;
  action: "insert" | "update" | "delete";
}

describe("/v1/admin/audit-log — spec:2124, acceptance test 13; SAH-029, 030, 040", () => {
  let api: StartedApi;
  let a: Seed;
  let b: Seed;

  const page = async (query: string): Promise<{ items: Entry[]; next_cursor: string | null }> => {
    const response = await api.request({
      method: "GET",
      path: `/v1/admin/audit-log?${query}`,
      as: a.human,
    });
    expect(response.status, query).toBe(200);
    return (await response.json()) as { items: Entry[]; next_cursor: string | null };
  };

  beforeAll(async () => {
    api = await startApi();
    a = await seedTenant(api.db, "Alpha");
    b = await seedTenant(api.db, "Beta");
    const roleId = await uuidv7(api.db.admin);
    await withTenant(api.db.migrator, a.tenant, a.system, async (tx) => {
      await tx`insert into app.role (id, tenant_id, code, name_en)
               values (${roleId}, ${a.tenant}, 'auditor', 'Auditor')`;
      await tx`insert into app.role_permission (tenant_id, role_id, permission_code)
               values (${a.tenant}, ${roleId}, 'admin.audit_log.read')`;
      await tx`insert into app.role_assignment (tenant_id, principal_id, role_id, company_id)
               values (${a.tenant}, ${a.human}, ${roleId}, ${a.company})`;
    });
  });
  afterAll(async () => api.stop());

  it("orders by seq descending and carries seq as a string, not a number", async () => {
    const body = await page("limit=5");
    expect(body.items.length).toBeGreaterThan(0);
    // bigint on the wire is a string: a JSON number would silently lose precision past 2^53.
    for (const item of body.items) expect(typeof item.seq).toBe("string");
    const seqs = body.items.map((item) => BigInt(item.seq));
    expect(seqs).toEqual(seqs.toSorted((x, y) => (x < y ? 1 : x > y ? -1 : 0)));
  });

  it("shows this tenant's rows only, though the other tenant has plenty (acceptance test 12)", async () => {
    const [beta] = await api.db.admin<{ n: number }[]>`
      select count(*)::int as n from app.audit_log where tenant_id = ${b.tenant}`;
    expect(beta!.n).toBeGreaterThan(0);

    const body = await page("limit=1000");
    const rowIds = new Set(body.items.map((item) => item.rowId));
    expect(rowIds.has(a.company)).toBe(true);
    expect(rowIds.has(b.company)).toBe(false);
    expect(rowIds.has(b.human)).toBe(false);
    // RLS narrows the read to one tenant, so every visible row belongs to Alpha.
    const [visible] = await api.db.admin<{ n: number }[]>`
      select count(*)::int as n from app.audit_log
       where tenant_id = ${a.tenant} and seq::text = any(${body.items.map((item) => item.seq)}::text[])`;
    expect(visible!.n).toBe(body.items.length);
  });

  it("pages with a cursor without repeating or skipping a row", async () => {
    const all = (await page("limit=1000")).items.map((item) => item.seq);
    expect(all.length).toBeGreaterThan(6);

    const first = await page("limit=3");
    expect(first.items.map((item) => item.seq)).toEqual(all.slice(0, 3));
    expect(first.next_cursor).not.toBeNull();
    const second = await page(`limit=3&cursor=${first.next_cursor}`);
    expect(second.items.map((item) => item.seq)).toEqual(all.slice(3, 6)); // no skip…
    const seen = new Set(first.items.map((item) => item.seq));
    expect(second.items.filter((item) => seen.has(item.seq))).toEqual([]); // …and no overlap
  });

  it("filters on the declared fields, strips undeclared ones, and refuses a caller-supplied sort (test 27)", async () => {
    const filtered = await page("tableName=company&action=insert&limit=50");
    expect(filtered.items.length).toBeGreaterThan(0);
    expect(
      filtered.items.every((item) => item.tableName === "company" && item.action === "insert"),
    ).toBe(true);
    const byActor = await page(`actorId=${a.system}&limit=50`);
    expect(byActor.items.every((item) => item.actorId === a.system)).toBe(true);

    // `sort` is declared by ListQuery but bounded to the empty string on this resource
    // (packages/contracts/src/admin/audit-log.ts) — the audit log is always `seq desc`. An empty value is
    // still accepted, so the refusal below is the bound firing, not the parameter being unknown.
    expect((await page("sort=&limit=1")).items).toHaveLength(1);
    // Undeclared keys are stripped rather than rejected: the schema is not `.strict()` (SAH-036).
    expect((await page("where=1&filter=x&limit=1")).items).toHaveLength(1);

    const injected = await api.request({
      method: "GET",
      path: "/v1/admin/audit-log?sort=seq;drop%20table%20app.tenant",
      as: a.human,
    });
    expect(injected.status).toBe(400);
    const body = (await injected.json()) as Problem;
    expect(body.code).toBe("ERR_VALIDATION_FAILED");
    expect(body.errors?.map((error) => error.path)).toContain("sort");
    const [still] = await api.db.admin<{ n: number }[]>`select count(*)::int as n from app.tenant`;
    expect(still!.n).toBeGreaterThan(0);
  });
});
