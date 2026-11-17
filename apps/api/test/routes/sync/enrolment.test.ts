import { createEnrolment, createTerminal, withTenant } from "@dulja/db";
import { runLoaders } from "@dulja/db/seed";
import { POS_PACK_ROOT } from "../../../../../tests/invariants/support/pos";
// apps/api/test/routes/sync/enrolment.test.ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { seedTenantV2, grantCodes, uuidv7, type Seed } from "@dulja/db/test";
import { startApi, type StartedApi } from "../../support/app";
import type { Problem } from "@dulja/contracts";

const spki = (): string =>
  generateKeyPairSync("ed25519")
    .publicKey.export({ format: "der", type: "spki" })
    .toString("base64");

describe("terminal enrolment (§4.10.3, spec:1322)", () => {
  let api: StartedApi;
  let s: Seed;
  beforeAll(async () => {
    api = await startApi();
    s = await seedTenantV2(api.db, "Alpha");
    await runLoaders(
      api.db.rw,
      {
        config: {} as never,
        tenantId: s.tenant,
        companyId: s.company,
        systemPrincipalId: s.system,
        packRoot: POS_PACK_ROOT,
      },
      ["roles"],
      "roles",
    );
    await grantCodes(api.db, s, { codes: ["admin.terminal.manage"] });
  }, 180_000);
  afterAll(async () => {
    await api.stop();
  });

  const issue = async (code = "KL01"): Promise<{ code: string; enrolmentId: string }> => {
    const res = await api.request({
      method: "POST",
      path: "/v1/admin/terminals/enrolments",
      as: s.human,
      body: { companyId: s.company, branchId: s.hq, name: `Till ${code}`, terminalCode: code },
    });
    expect(res.status).toBe(201);
    return (await res.json()) as { code: string; enrolmentId: string };
  };

  it("issues a code once, under admin.terminal.manage, and never returns it again", async () => {
    const issued = await issue();
    expect(issued.code).toMatch(/^[A-Z2-7]{32}$/);
    const list = await api.request({
      method: "GET",
      path: `/v1/admin/terminals/enrolments?companyId=${s.company}`,
      as: s.human,
    });
    expect(list.status).toBe(200);
    const body = (await list.json()) as { items: Record<string, unknown>[] };
    expect(body.items).toHaveLength(1);
    // The code is a bearer secret shown once (spec:1322). Neither it nor its hash is ever in a response.
    expect(JSON.stringify(body)).not.toContain(issued.code);
    expect(Object.keys(body.items[0]!)).not.toContain("codeHash");
  });

  it("redeems it once — the second attempt is ERR_TERMINAL_ENROLMENT_INVALID", async () => {
    const issued = await issue("KL02");
    const key = spki();
    const first = await api.request({
      method: "POST",
      path: "/v1/sync/enrol",
      body: { code: issued.code, devicePublicKey: key },
    });
    expect(first.status).toBe(201);
    const { terminalId } = (await first.json()) as { terminalId: string };
    expect(terminalId).toMatch(/^[0-9a-f-]{36}$/);

    const second = await api.request({
      method: "POST",
      path: "/v1/sync/enrol",
      body: { code: issued.code, devicePublicKey: spki() },
    });
    expect(second.status).toBe(400);
    expect(((await second.json()) as Problem).code).toBe("ERR_TERMINAL_ENROLMENT_INVALID");
  });

  it("an unknown code answers the SAME problem — a probe learns nothing (LEGACY-025)", async () => {
    const res = await api.request({
      method: "POST",
      path: "/v1/sync/enrol",
      body: { code: "A".repeat(32), devicePublicKey: spki() },
    });
    expect(res.status).toBe(400);
    const p = (await res.json()) as Problem;
    expect(p.code).toBe("ERR_TERMINAL_ENROLMENT_INVALID");
    expect(p.detail).not.toContain(s.tenant);
    expect(p.detail).not.toContain(s.company);
  });

  it("the redeemed terminal owns a `terminal` principal holding exactly pos_terminal (R8, spec:2179)", async () => {
    const issued = await issue("KL03");
    const res = await api.request({
      method: "POST",
      path: "/v1/sync/enrol",
      body: { code: issued.code, devicePublicKey: spki() },
    });
    const { terminalId } = (await res.json()) as { terminalId: string };

    const [row] = await api.db.admin<{ kind: string; auth_subject: string; codes: string[] }[]>`
      select p.kind::text as kind, p.auth_subject,
             coalesce(array_agg(rp.permission_code order by rp.permission_code) filter (where rp.permission_code is not null), '{}') as codes
        from app.pos_terminal t
        join app.principal p on p.id = t.principal_id
        left join app.role_assignment ra on ra.principal_id = p.id
        left join app.role_permission rp on rp.role_id = ra.role_id
       where t.id = ${terminalId}
       group by p.kind, p.auth_subject`;
    expect(row!.kind).toBe("terminal");
    expect(row!.auth_subject).toBe(`terminal:${terminalId}`);
    expect(row!.codes).toEqual(["pos.sync.pull", "pos.sync.push"]);

    const [branchRows] = await api.db.admin<{ n: number }[]>`
      select count(*)::int as n from app.role_assignment_branch b
        join app.role_assignment ra on ra.principal_id = b.principal_id and ra.role_id = b.role_id
        join app.pos_terminal t on t.principal_id = ra.principal_id
       where t.id = ${terminalId} and b.branch_id = ${s.hq}`;
    expect(branchRows!.n).toBe(1); // R8: the assignment is narrowed to the terminal's branch
  });

  it("the public route carries NO idempotency: a key is ignored, not a 500 (Task 0 amendment 21)", async () => {
    // §4.2.9's middleware keys on (tenant_id, principal_id, key) and opens withTenant on c.var.ctx, which a
    // public route does not have. If it were mounted here every enrolment would be ERR_TENANT_CONTEXT_MISSING
    // (500) — the failure mode this case exists to forbid. A key sent anyway is simply an unread header.
    const issued = await issue("KL04");
    const key = crypto.randomUUID();
    const first = await api.request({
      method: "POST",
      path: "/v1/sync/enrol",
      body: { code: issued.code, devicePublicKey: spki() },
      idempotencyKey: key,
    });
    expect(first.status).toBe(201);
    expect(first.headers.get("Idempotency-Replayed"), "no store, so nothing to replay").toBeNull();

    // The SAME key on the SAME body is NOT replayed — and the answer is still correct, because redemption is
    // idempotent in its own right: `where redeemed_at is null` already spent the code.
    const second = await api.request({
      method: "POST",
      path: "/v1/sync/enrol",
      body: { code: issued.code, devicePublicKey: spki() },
      idempotencyKey: key,
    });
    expect(second.status).toBe(400);
    expect(((await second.json()) as Problem).code).toBe("ERR_TERMINAL_ENROLMENT_INVALID");

    // And no header at all is equally fine — the route never demands one (contrast /v1/sync/tickets, which
    // does, and whose ERR_IDEMPOTENCY_KEY_MISSING case is Task 12's).
    const third = await api.request({
      method: "POST",
      path: "/v1/sync/enrol",
      body: { code: "B".repeat(32), devicePublicKey: spki() },
      idempotencyKey: null,
    });
    expect(third.status).toBe(400);
    expect(((await third.json()) as Problem).code).toBe("ERR_TERMINAL_ENROLMENT_INVALID");
  });

  it("issuing needs the code — a principal without admin.terminal.manage is 403", async () => {
    const other = await seedTenantV2(api.db, "Gamma");
    const res = await api.request({
      method: "POST",
      path: "/v1/admin/terminals/enrolments",
      as: other.human,
      body: { companyId: other.company, branchId: other.hq, name: "Till", terminalCode: "G1" },
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as Problem).code).toBe("ERR_RBAC_FORBIDDEN");
  });
  it("uses the same public auth mode for encoded routed paths and never for a lookalike prefix", async () => {
    const issued = await issue("ENCODED");
    const response = await api.request({
      method: "POST",
      path: "/v1/sync/%65nrol",
      body: { code: issued.code, devicePublicKey: spki() },
      idempotencyKey: null,
    });
    expect(response.status).toBe(201);
    const denied = await api.request({ method: "POST", path: "/v1/sync/enrol-extra", body: {} });
    expect(denied.status).toBe(401);
    const session = await api.request({ method: "GET", path: "/v1/session", as: s.human });
    expect(session.status).toBe(200);
  });

  it("requires a valid Ed25519 key and leaves the code unspent when registration fails", async () => {
    const issued = await issue("KEYCHECK");
    const bad = await api.request({
      method: "POST",
      path: "/v1/sync/enrol",
      body: { code: issued.code, devicePublicKey: Buffer.alloc(44).toString("base64") },
    });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as Problem).code).toBe("ERR_VALIDATION_FAILED");
    expect(
      (
        await api.request({
          method: "POST",
          path: "/v1/sync/enrol",
          body: { code: issued.code, devicePublicKey: spki() },
        })
      ).status,
    ).toBe(201);
  });

  it("redeems a code only once when two devices race", async () => {
    const issued = await issue("RACE");
    const answers = await Promise.all(
      [spki(), spki()].map((devicePublicKey) =>
        api.request({
          method: "POST",
          path: "/v1/sync/enrol",
          body: { code: issued.code, devicePublicKey },
        }),
      ),
    );
    expect(answers.map((r) => r.status).toSorted()).toEqual([201, 400]);
    const [count] = await api.db.admin<{ n: number }[]>`
      select count(*)::int as n from app.pos_terminal where company_id = ${s.company} and code = 'RACE'`;
    expect(count!.n).toBe(1);
  });

  it("binds list, revocation and issuance to the company where the caller holds management authority", async () => {
    const companyId = await uuidv7(api.db.admin);
    const branchTypeId = await uuidv7(api.db.admin);
    const branchId = await uuidv7(api.db.admin);
    const terminal = await withTenant(
      api.db.rw,
      { tenantId: s.tenant, actorId: s.system, requestId: "other-company" },
      async (tx) => {
        await tx`insert into app.company (id, tenant_id, code, name, base_currency)
        values (${companyId}, ${s.tenant}, 'OTHER', 'Other company', 'MYR')`;
        await tx`insert into app.dimension_type (id, tenant_id, company_id, code, name_en)
        values (${branchTypeId}, ${s.tenant}, ${companyId}, 'BRANCH', 'Branch')`;
        await tx`insert into app.dimension_value (id, tenant_id, dimension_type_id, code, name_en)
        values (${branchId}, ${s.tenant}, ${branchTypeId}, 'HQ', 'HQ')`;
        await createEnrolment(
          tx,
          { tenantId: s.tenant, actorId: s.system, requestId: "other-company" },
          { companyId, branchId, name: "Other till", terminalCode: "OTHER" },
        );
        return createTerminal(tx, {
          companyId,
          branchId,
          name: "Other till",
          code: "OTHER",
          devicePublicKey: Buffer.from(spki(), "base64"),
        });
      },
    );
    expect(
      (
        await api.request({
          method: "GET",
          path: `/v1/admin/terminals/enrolments?companyId=${companyId}`,
          as: s.human,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await api.request({
          method: "POST",
          path: `/v1/admin/terminals/${terminal.terminalId}/revoke`,
          as: s.human,
        })
      ).status,
    ).toBe(204);
    const [row] = await api.db.admin<{ revoked_at: string | null }[]>`
      select revoked_at from app.pos_terminal where id = ${terminal.terminalId}`;
    expect(row!.revoked_at).toBeNull();
    const wrongBranch = await api.request({
      method: "POST",
      path: "/v1/admin/terminals/enrolments",
      as: s.human,
      body: { companyId: s.company, branchId, name: "Wrong company", terminalCode: "BADBRANCH" },
    });
    expect(wrongBranch.status).toBe(404);

    // Issuance, the case tests/invariants/probes.ts defers to this file: `s.human` HOLDS admin.terminal.manage
    // in its own company and asks to enrol a terminal into a company where it holds nothing — first another
    // company of its own tenant, then a company of a second tenant. Both are the body:companyId gate's 403,
    // and neither leaves an enrolment row behind (the code would be a bearer ticket into that company).
    const victim = await seedTenantV2(api.db, "Delta");
    for (const target of [
      { companyId, branchId, terminalCode: "XCOMPANY" },
      { companyId: victim.company, branchId: victim.hq, terminalCode: "XTENANT" },
    ]) {
      const refused = await api.request({
        method: "POST",
        path: "/v1/admin/terminals/enrolments",
        as: s.human,
        body: { ...target, name: "Foreign till" },
      });
      expect(refused.status, target.terminalCode).toBe(403);
      expect(((await refused.json()) as Problem).code, target.terminalCode).toBe(
        "ERR_RBAC_FORBIDDEN",
      );
      const [made] = await api.db.admin<{ n: number }[]>`
        select count(*)::int as n from app.terminal_enrolment where terminal_code = ${target.terminalCode}`;
      expect(made!.n, target.terminalCode).toBe(0);
    }
  });

  it("returns an issuance secret only once and stores a safe replay refusal in the same transaction", async () => {
    const idempotencyKey = "one-shot-enrolment";
    const body = {
      companyId: s.company,
      branchId: s.hq,
      name: "One-shot till",
      terminalCode: "ONESHOT",
    };
    const first = await api.request({
      method: "POST",
      path: "/v1/admin/terminals/%65nrolments",
      as: s.human,
      idempotencyKey,
      body,
    });
    expect(first.status).toBe(201);
    const issued = (await first.json()) as { code: string; enrolmentId: string };
    expect(issued.code).toMatch(/^[A-Z2-7]{32}$/);
    const [stored] = await api.db.admin<{ response_code: number; response_body: unknown }[]>`
      select response_code, response_body from app.idempotency_key
       where tenant_id = ${s.tenant} and principal_id = ${s.human} and key = ${idempotencyKey}`;
    expect(stored!.response_code).toBe(409);
    expect(stored!.response_body).toMatchObject({ code: "ERR_IDEMPOTENCY_KEY_REUSED" });
    expect(JSON.stringify(stored!.response_body)).not.toContain(issued.code);
    const replay = await api.request({
      method: "POST",
      path: "/v1/admin/terminals/enrolments",
      as: s.human,
      idempotencyKey,
      body,
    });
    expect(replay.status).toBe(409);
    expect(await replay.text()).not.toContain(issued.code);
    await withTenant(
      api.db.rw,
      { tenantId: s.tenant, actorId: s.system, requestId: "remove-management" },
      async (tx) => {
        await tx`delete from app.role_permission where permission_code = 'admin.terminal.manage'
        and role_id in (select role_id from app.role_assignment where principal_id = ${s.human})`;
      },
    );
    try {
      const noAuthority = await api.request({
        method: "POST",
        path: "/v1/admin/terminals/%65nrolments",
        as: s.human,
        idempotencyKey,
        body,
      });
      expect(noAuthority.status).toBe(409);
      expect(await noAuthority.text()).not.toContain(issued.code);
    } finally {
      await grantCodes(api.db, s, { codes: ["admin.terminal.manage"] });
    }
    const [count] = await api.db.admin<{ n: number }[]>`
      select count(*)::int as n from app.terminal_enrolment where id = ${issued.enrolmentId}`;
    expect(count!.n).toBe(1);
  });

  // PR 12 review, finding 14: the plain unique this replaced kept an unredeemed code's terminal code for ever.
  it("a terminal code is 409 while an enrolment holds it, and free again once that one expired unredeemed", async () => {
    const reissue = () =>
      api.request({
        method: "POST",
        path: "/v1/admin/terminals/enrolments",
        as: s.human,
        body: { companyId: s.company, branchId: s.hq, name: "Till again", terminalCode: "EXPIRE" },
      });
    const first = await issue("EXPIRE");
    const clash = await reissue();
    expect(clash.status).toBe(409);
    expect(((await clash.json()) as Problem).code).toBe("ERR_CONFLICT_UNIQUE");

    // The till never redeemed it inside its hour: move the row two hours back in time.
    await withTenant(
      api.db.rw,
      { tenantId: s.tenant, actorId: s.system, requestId: "expire" },
      (tx) =>
        tx`update app.terminal_enrolment set created_at = now() - interval '2 hours', expires_at = now() - interval '1 hour'
          where id = ${first.enrolmentId}`,
    );
    const again = await reissue();
    expect(again.status).toBe(201);
    const second = (await again.json()) as { code: string; enrolmentId: string };
    expect(second.enrolmentId).not.toBe(first.enrolmentId);

    // The spent-by-time code redeems nothing; the new one redeems and then holds the code for ever.
    const stale = await api.request({
      method: "POST",
      path: "/v1/sync/enrol",
      body: { code: first.code, devicePublicKey: spki() },
    });
    expect(stale.status).toBe(400);
    const fresh = await api.request({
      method: "POST",
      path: "/v1/sync/enrol",
      body: { code: second.code, devicePublicKey: spki() },
    });
    expect(fresh.status).toBe(201);
    // Past its expiry too (issued just after the first one lapsed, so only its end moves): redeemed, it still holds.
    await withTenant(
      api.db.rw,
      { tenantId: s.tenant, actorId: s.system, requestId: "expire" },
      (tx) =>
        tx`update app.terminal_enrolment set expires_at = created_at + interval '1 millisecond'
          where id = ${second.enrolmentId}`,
    );
    expect((await reissue()).status).toBe(409);
  });

  it("caches failed issuance responses normally without creating an enrolment", async () => {
    const input = {
      method: "POST" as const,
      path: "/v1/admin/terminals/enrolments",
      as: s.human,
      idempotencyKey: "failed-one-shot",
      body: { companyId: s.company, branchId: s.hq, name: "Invalid", terminalCode: "lowercase" },
    };
    const first = await api.request(input);
    expect(first.status).toBe(400);
    const expected = await first.json();
    const replay = await api.request(input);
    expect(replay.status).toBe(400);
    expect(await replay.json()).toEqual(expected);
    const [count] = await api.db.admin<{ n: number }[]>`
      select count(*)::int as n from app.terminal_enrolment where company_id = ${s.company} and terminal_code = 'lowercase'`;
    expect(count!.n).toBe(0);
  });
});
