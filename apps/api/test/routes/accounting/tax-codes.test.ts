import { afterAll, beforeAll, describe, expect, it } from "vitest";
// The two paths 4B's route test uses (phase-4b:6362-6365): `startApi` from apps/api's own support module,
// `problemOf` from the root tests/ one.
import { startApi, type StartedApi } from "../../support/app";
import { problemOf } from "../../../../../tests/support/api";
import {
  grantCodes,
  seedAccount,
  seedTaxCode,
  seedTenantV2,
  type Db,
  type Seed,
} from "@dulja/db/test";
// 3D exported 3B's module-private helper for exactly this shape of case: a second human in the SAME tenant
// and company, holding no grant of its own (phase-3d:206). Using another tenant's principal instead would
// make the request wrong-tenant rather than wrong-permission, and which status the scope check answers for
// a company outside the caller's tenant is not something this plan may assume.
import { secondPrincipal } from "../../../../../tests/invariants/support/post-inventory";

let db: Db;
let api: StartedApi;
let a: Seed;
let ungranted: string;
let regimeId: string;

beforeAll(async () => {
  api = await startApi();
  db = api.db;
  a = await seedTenantV2(db, "taxapi-a");
  await seedAccount(db, a, { code: "2300", nameEn: "Output tax payable", type: "liability" });
  await grantCodes(db, a, { codes: ["accounting.tax.manage"] });
  ungranted = await secondPrincipal(db, a, "no-tax-grant");
  ({ regimeId } = await seedTaxCode(db, a, { code: "SYN-OUT-STD" }));
}, 300_000);
afterAll(async () => {
  await api?.stop();
});

const base = () => `/v1/companies/${a.company}/tax-codes`;

describe("tax-codes routes (§4.2.7, §4.2.8)", () => {
  it("GET / lists the company's codes in (code, id) order", async () => {
    const res = await api.request({ method: "GET", path: `${base()}?limit=50`, as: a.human });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: { code: string; rate: string; regimeCode: string }[];
    };
    expect(body.items.map((i) => i.code)).toEqual(["SYN-OUT-STD"]);
    expect(body.items[0]!.rate).toBe("0.11000000");
    expect(body.items[0]!.regimeCode).toBe("SYNTH-MY-v1");
  });

  it("POST / creates a code and resolves its account by §4.15 CODE", async () => {
    const res = await api.request({
      method: "POST",
      path: base(),
      as: a.human,
      idempotencyKey: crypto.randomUUID(),
      body: {
        regimeId,
        code: "SYN-OUT-B",
        nameEn: "Second output (synthetic)",
        rate: "0.11000000",
        kind: "output",
        roundingMode: "HALF_EVEN",
        accountCode: "2300",
        effectiveFrom: "2026-04-01",
      },
    });
    expect(res.status).toBe(201);
    const dto = (await res.json()) as { outputAccountId: string | null; roundingMode: string };
    expect(dto.outputAccountId).not.toBeNull();
    expect(dto.roundingMode).toBe("HALF_EVEN");
  });

  it("POST / with an accountCode the company lacks is 422 ERR_POLICY_REQUIRES_MISSING", async () => {
    const res = await api.request({
      method: "POST",
      path: base(),
      as: a.human,
      idempotencyKey: crypto.randomUUID(),
      body: {
        regimeId,
        code: "SYN-NO-ACCT",
        nameEn: "No account",
        rate: "0.11000000",
        kind: "input",
        roundingMode: "HALF_AWAY_FROM_ZERO",
        accountCode: "1350",
        effectiveFrom: "2026-04-01",
      },
    });
    expect(res.status).toBe(422);
    expect((await problemOf(res)).code).toBe("ERR_POLICY_REQUIRES_MISSING");
  });

  it("POST / an output code on an account that is not a liability is 422 ERR_POLICY_REQUIRES_MISSING", async () => {
    // PR 11 review, round 3: the tie-out reads an output code's account with a liability's sign, so an
    // output code on the asset 1000 would tie out inverted. Refused at creation, with the documented 422.
    const res = await api.request({
      method: "POST",
      path: base(),
      as: a.human,
      idempotencyKey: crypto.randomUUID(),
      body: {
        regimeId,
        code: "SYN-OUT-ASSET",
        nameEn: "Output on an asset (synthetic)",
        rate: "0.11000000",
        kind: "output",
        roundingMode: "HALF_AWAY_FROM_ZERO",
        accountCode: "1000",
        effectiveFrom: "2026-04-01",
      },
    });
    expect(res.status).toBe(422);
    const problem = await problemOf(res);
    expect(problem.code).toBe("ERR_POLICY_REQUIRES_MISSING");
    expect(problem.detail).toContain("account 1000 is asset");
  });

  it("every unsafe route refuses a missing idempotency key (§4.2.9)", async () => {
    for (const path of [base(), `${base()}/${crypto.randomUUID()}/archive`]) {
      const res = await api.request({
        method: "POST",
        path,
        as: a.human,
        idempotencyKey: null,
        body: {},
      });
      expect(res.status, path).toBe(400);
      expect((await problemOf(res)).code, path).toBe("ERR_IDEMPOTENCY_KEY_MISSING");
    }
  });

  it("a replayed key returns the stored body with Idempotency-Replayed: true", async () => {
    const key = crypto.randomUUID();
    const body = {
      regimeId,
      code: "SYN-REPLAY",
      nameEn: "Replay (synthetic)",
      rate: "0.11000000",
      kind: "output",
      roundingMode: "HALF_AWAY_FROM_ZERO",
      accountCode: "2300",
      effectiveFrom: "2026-05-01",
    };
    const first = await api.request({
      method: "POST",
      path: base(),
      as: a.human,
      idempotencyKey: key,
      body,
    });
    const again = await api.request({
      method: "POST",
      path: base(),
      as: a.human,
      idempotencyKey: key,
      body,
    });
    expect(again.headers.get("Idempotency-Replayed")).toBe("true");
    expect(await again.json()).toEqual(await first.json());
  });

  it("POST /{id}/archive is 200 with the archived row, and archiving twice is 404 (spec:2049 — archived, never deleted)", async () => {
    const { taxCodeId } = await seedTaxCode(db, a, { code: "SYN-ARCH" });
    const path = `${base()}/${taxCodeId}/archive`;
    const first = await api.request({
      method: "POST",
      path,
      as: a.human,
      idempotencyKey: crypto.randomUUID(),
    });
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ id: taxCodeId, archivedAt: expect.any(String) });
    const second = await api.request({
      method: "POST",
      path,
      as: a.human,
      idempotencyKey: crypto.randomUUID(),
    });
    expect(second.status).toBe(404);
    expect((await problemOf(second)).code).toBe("ERR_NOT_FOUND");
  });

  // MON-13 (2026-11-15 full review). A retried archive under the same Idempotency-Key replays the stored answer;
  // a stored 204 could not be replayed (a 204 Response takes no body) and answered 500 ERR_INTERNAL.
  it("a replayed POST /{id}/archive answers the stored response, not 500", async () => {
    const { taxCodeId } = await seedTaxCode(db, a, { code: "SYN-ARCH-R" });
    const path = `${base()}/${taxCodeId}/archive`;
    const key = crypto.randomUUID();
    const first = await api.request({ method: "POST", path, as: a.human, idempotencyKey: key });
    const again = await api.request({ method: "POST", path, as: a.human, idempotencyKey: key });
    expect(again.status).toBe(first.status);
    expect(again.headers.get("Idempotency-Replayed")).toBe("true");
    expect(await again.json()).toEqual(await first.json());
  });

  it("a principal of THIS tenant without accounting.tax.manage is 403 ERR_RBAC_FORBIDDEN", async () => {
    // Same tenant, same company, no grant — so the only thing that can refuse is `requirePermission`, and
    // the status is unambiguous. (A wrong-TENANT request is a different question with a different answer,
    // and the probe in `tests/invariants/probes.ts` is what owns it.)
    const res = await api.request({ method: "GET", path: base(), as: ungranted });
    expect(res.status).toBe(403);
    expect((await problemOf(res)).code).toBe("ERR_RBAC_FORBIDDEN");
  });

  it("an undeclared query parameter is ERR_VALIDATION_FAILED — .strict() is what produces it", async () => {
    const res = await api.request({
      method: "GET",
      path: `${base()}?filter[rate][eq]=0.11000000`,
      as: a.human,
    });
    expect(res.status).toBe(400);
    expect((await problemOf(res)).code).toBe("ERR_VALIDATION_FAILED");
  });
});
