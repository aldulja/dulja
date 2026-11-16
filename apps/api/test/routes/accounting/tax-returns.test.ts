import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startApi, type StartedApi } from "../../support/app";
import { problemOf } from "../../../../../tests/support/api";
import { type Db } from "@dulja/db/test";
import {
  postTaxedDocument,
  taxFixture,
  type TaxFixture,
} from "../../../../../tests/invariants/support/tax";

let db: Db;
let api: StartedApi;
let f: TaxFixture;
let g: TaxFixture; // a SECOND tenant, for the cross-tenant reads
let returnId: string;

const Q1 = { periodStart: "2026-01-01", periodEnd: "2026-03-31" };

beforeAll(async () => {
  api = await startApi();
  db = api.db;
  f = await taxFixture(db, "returnsapi-a");
  g = await taxFixture(db, "returnsapi-b");
  await postTaxedDocument(db, f, {
    typeCode: "SALES_INVOICE",
    effectiveDate: "2026-01-15",
    lines: [{ lineNo: 1, amount: "1000.0000", taxCode: "SYN-OUT-STD" }],
  });
}, 300_000);
afterAll(async () => {
  await api?.stop();
});

const base = (t: TaxFixture) => `/v1/companies/${t.s.company}/tax-returns`;
const create = (t: TaxFixture, body: Record<string, unknown>) =>
  api.request({
    method: "POST",
    path: base(t),
    as: t.s.human,
    idempotencyKey: crypto.randomUUID(),
    body,
  });

describe("tax-returns routes (§4.2.7, the Phase 5 DoD's API half)", () => {
  it("POST / reserves the period and answers 201", async () => {
    const res = await create(f, { regimeCode: "SYNTH-MY-v1", regimeVersion: 1, ...Q1 });
    expect(res.status).toBe(201);
    const dto = (await res.json()) as { id: string; status: string; payloadSha256: string | null };
    expect(dto).toMatchObject({ status: "draft", payloadSha256: null });
    returnId = dto.id;
  });

  it("a second reservation of the same period is 409 ERR_CONFLICT_UNIQUE", async () => {
    const res = await create(f, { regimeCode: "SYNTH-MY-v1", regimeVersion: 1, ...Q1 });
    expect(res.status).toBe(409);
    expect((await problemOf(res)).code).toBe("ERR_CONFLICT_UNIQUE");
  });

  it("a range overlapping a reserved one is 409 ERR_CONFLICT_UNIQUE naming that return", async () => {
    // Feb–Apr against Jan–Mar has a different period_start, so the unique key never saw it: it used to
    // answer 201, and February and March were then reported by two returns (PR 11 review, round 3).
    const res = await create(f, {
      regimeCode: "SYNTH-MY-v1",
      regimeVersion: 1,
      periodStart: "2026-02-01",
      periodEnd: "2026-04-30",
    });
    expect(res.status).toBe(409);
    const problem = await problemOf(res);
    expect(problem.code).toBe("ERR_CONFLICT_UNIQUE");
    expect(problem.detail).toContain(`overlaps tax return ${returnId} (2026-01-01..2026-03-31`);
  });

  it("a regime the TENANT does not have is 404, not 403 and not 422 — a probe learns nothing", async () => {
    const res = await create(f, { regimeCode: "SYNTH-MY-v9", regimeVersion: 9, ...Q1 });
    expect(res.status).toBe(404);
    expect((await problemOf(res)).code).toBe("ERR_NOT_FOUND");
  });

  it("a window that cuts a fiscal period in half is 422 ERR_POLICY_REQUIRES_MISSING", async () => {
    const res = await create(f, {
      regimeCode: "SYNTH-MY-v1",
      regimeVersion: 1,
      periodStart: "2026-04-15",
      periodEnd: "2026-06-30",
    });
    expect(res.status).toBe(422);
    expect((await problemOf(res)).code).toBe("ERR_POLICY_REQUIRES_MISSING");
  });

  it("POST /{id}/generate returns the detail, and GET /{id} returns the identical bytes", async () => {
    const gen = await api.request({
      method: "POST",
      path: `${base(f)}/${returnId}/generate`,
      as: f.s.human,
      idempotencyKey: crypto.randomUUID(),
    });
    expect(gen.status).toBe(200);
    const detail = (await gen.json()) as {
      taxReturn: { status: string; payloadSha256: string | null };
      boxes: { code: string; amount: string }[];
      payload: string | null;
      tieOut: { accountCode: string; difference: string }[];
      currency: string;
    };
    expect(detail.taxReturn.status).toBe("generated");
    expect(detail.taxReturn.payloadSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(detail.boxes.find((b) => b.code === "S2")!.amount).toBe("110.0000");
    expect(detail.tieOut.map((r) => r.difference)).toEqual(["0.0000", "0.0000"]);
    expect(detail.currency).toBe("MYR");

    const read = await api.request({
      method: "GET",
      path: `${base(f)}/${returnId}`,
      as: f.s.human,
    });
    expect(read.status).toBe(200);
    expect(((await read.json()) as { payload: string }).payload).toBe(detail.payload);
  });

  it("GET /{id} on a DRAFT is 200 with no boxes and an empty tieOut, never a 422", async () => {
    const made = await create(f, {
      regimeCode: "SYNTH-MY-v1",
      regimeVersion: 1,
      periodStart: "2026-07-01",
      periodEnd: "2026-09-30",
    });
    const { id } = (await made.json()) as { id: string };
    const res = await api.request({ method: "GET", path: `${base(f)}/${id}`, as: f.s.human });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ boxes: [], tieOut: [], payload: null });
  });

  it("a generate whose regime the PACK has no definition for is 422 ERR_TAX_REGIME_MISMATCH", async () => {
    // The reachable half of amendment A3. A *foreign-regime transaction* cannot be provoked through the
    // API — `transactionsFor` binds `t.regime_id` — and a mixed-regime document never posts at all.
    const gctx = { tenantId: g.s.tenant, actorId: g.s.human, requestId: "unknown-regime" };
    const [other] = await (
      await import("@dulja/db")
    ).withTenant(
      db.rw,
      gctx,
      (tx) => tx<{ id: string }[]>`
      insert into app.tax_regime (tenant_id, company_id, code, jurisdiction, version, effective_from,
                                  name_en, source)
      values (${g.s.tenant}, ${g.s.company}, 'OTHER-MY-v1', 'MY', 1, '2026-01-01',
              'Second synthetic regime', 'SYNTHETIC-TEST-v1 — not a published figure (OD-15)')
      returning id`,
    );
    expect(other).toBeDefined();
    const made = await create(g, { regimeCode: "OTHER-MY-v1", regimeVersion: 1, ...Q1 });
    const { id } = (await made.json()) as { id: string };
    const res = await api.request({
      method: "POST",
      path: `${base(g)}/${id}/generate`,
      as: g.s.human,
      idempotencyKey: crypto.randomUUID(),
    });
    expect(res.status).toBe(422);
    expect((await problemOf(res)).code).toBe("ERR_TAX_REGIME_MISMATCH");
  });

  it("another tenant's return id is 404 inside that tenant's own scope, and unsafe routes need a key", async () => {
    // The convention `tests/invariants/probes.ts` uses and the only one this plan may assert: tenant G asks
    // for a row id owned by F, under **G's own company path**, so the scope check passes and RLS is what
    // answers. A request against F's company path is a wrong-TENANT question whose status this plan does
    // not fix, and asserting a guess there is how a test gets "corrected" to whatever the framework did.
    const scoped = await api.request({
      method: "GET",
      path: `${base(g)}/${returnId}`,
      as: g.s.human,
    });
    expect(scoped.status).toBe(404);
    expect((await problemOf(scoped)).code).toBe("ERR_NOT_FOUND");
    for (const path of [base(f), `${base(f)}/${returnId}/generate`]) {
      const res = await api.request({
        method: "POST",
        path,
        as: f.s.human,
        idempotencyKey: null,
        body: {},
      });
      expect(res.status, path).toBe(400);
      expect((await problemOf(res)).code, path).toBe("ERR_IDEMPOTENCY_KEY_MISSING");
    }
  });
});
