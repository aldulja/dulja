// packages/db/test/sync/enrolment.test.ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { lintSchema } from "../../src/lint-schema";
import { createEnrolment, SyncError } from "../../src/sync/enrolment";
import { claimSignedRequest } from "../../src/sync/identity";
import { startDb, uuidv7, withTenant, type Db } from "../harness";
import { grantCodes, seedTenantV2, seedTerminal, type Seed } from "../fixtures";

const sha256 = (s: string): Buffer => createHash("sha256").update(s, "utf8").digest();
const ctx = (s: Seed) => ({ tenantId: s.tenant, actorId: s.human, requestId: "enrolment-test" });

describe("migration 0060 — terminal enrolment and the needs-attention queue", () => {
  let db: Db;
  let a: Seed;
  let b: Seed;
  beforeAll(async () => {
    db = await startDb();
    a = await seedTenantV2(db, "Alpha");
    await grantCodes(db, a);
    b = await seedTenantV2(db, "Beta");
    await grantCodes(db, b);
  }, 180_000);
  afterAll(async () => {
    await db.stop();
  });

  it("app.resolve_enrolment is SECURITY DEFINER owned by app_auth, WITH the app_auth grant and policy (§4.1)", async () => {
    const [f] = await db.admin<{ owner: string; secdef: boolean; bypass: boolean }[]>`
      select r.rolname as owner, p.prosecdef as secdef, r.rolbypassrls as bypass
        from pg_proc p join pg_roles r on r.oid = p.proowner
       where p.pronamespace = 'app'::regnamespace and p.proname = 'resolve_enrolment'`;
    expect(f).toEqual({ owner: "app_auth", secdef: true, bypass: false });

    // The three assertions below are what make the door open at all, and each fails silently without them:
    // app_auth is not the table owner and has no BYPASSRLS, so FORCE RLS applies to it inside the definer
    // body, and app.current_tenant() is NULL there. This is plan0A:1024-1026's pattern, asserted.
    const pols = await db.admin<{ polname: string; roles: string[] }[]>`
      select p.polname, coalesce(array_agg(r.rolname order by r.rolname), '{}') as roles
        from pg_policy p
        left join lateral unnest(p.polroles) pr(oid) on true
        left join pg_roles r on r.oid = pr.oid
       where p.polrelid = 'app.terminal_enrolment'::regclass
       group by p.polname order by p.polname`;
    expect(pols.map((p) => p.polname)).toEqual([
      "branch_isolation",
      "enrolment_resolver",
      "tenant_isolation",
    ]);
    expect(pols.find((p) => p.polname === "enrolment_resolver")!.roles).toEqual(["app_auth"]);

    expect(pols.find((p) => p.polname === "branch_isolation")!.roles).toEqual([
      "app_migrator",
      "app_rw",
    ]);

    const [grant] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from information_schema.role_table_grants
       where grantee = 'app_auth' and table_schema = 'app'
         and table_name = 'terminal_enrolment' and privilege_type = 'SELECT'`;
    expect(
      grant!.n,
      "app_auth holds SELECT — default privileges grant to app_rw only (plan0A:2564)",
    ).toBe(1);
  });

  it("resolves an unredeemed, unexpired code with NO tenant set — the pre-tenant door", async () => {
    const code = "ENROL-ALPHA-1";
    await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx`
      insert into app.terminal_enrolment (tenant_id, company_id, branch_id, code_hash, name, terminal_code, expires_at)
      values (${a.tenant}, ${a.company}, ${a.hq}, ${sha256(code)}, 'Front Till', 'T1', now() + interval '1 hour')`,
    );

    // A brand-new app_rw connection with NO set_config at all: exactly what the public /v1/sync/enrol
    // route has when it arrives (LEGACY-026 — identity is never client-supplied context).
    const rows = await db.rw<
      { enrolment_id: string; tenant_id: string; company_id: string; branch_id: string }[]
    >`
      select * from app.resolve_enrolment(${sha256(code)})`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tenant_id).toBe(a.tenant);

    expect(await db.rw`select * from app.resolve_enrolment(${sha256("WRONG")})`).toHaveLength(0);
  });

  it("a spent or expired code resolves to nothing (spec:1322 'the till redeems it ONCE')", async () => {
    const spent = "ENROL-SPENT";
    const stale = "ENROL-STALE";
    await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      // `name` and `terminal_code` are NOT NULL with no default, and `terminal_code` is unique per company,
      // so every row in this file needs its own — T2 and T3 here, T1 in the test above.
      await tx`insert into app.terminal_enrolment (tenant_id, company_id, branch_id, code_hash, name, terminal_code, expires_at, redeemed_at)
               values (${a.tenant}, ${a.company}, ${a.hq}, ${sha256(spent)}, 'Spent Till', 'T2', now() + interval '1 hour', now())`;
      // Issued two hours ago with a one-hour life: `check (expires_at > created_at)` refuses a row born expired.
      await tx`insert into app.terminal_enrolment (tenant_id, company_id, branch_id, code_hash, name, terminal_code, created_at, expires_at)
               values (${a.tenant}, ${a.company}, ${a.hq}, ${sha256(stale)}, 'Stale Till', 'T3', now() - interval '2 hours', now() - interval '1 second')`;
    });
    expect(await db.rw`select * from app.resolve_enrolment(${sha256(spent)})`).toHaveLength(0);
    expect(await db.rw`select * from app.resolve_enrolment(${sha256(stale)})`).toHaveLength(0);
  });

  it("needs_attention.resolved_by is NULL at insert and stamped on resolve, never client-supplied (LEGACY-044)", async () => {
    const clientRef = await uuidv7(db.admin);
    const id = await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      const [row] = await tx<{ id: string; resolved_by: string | null }[]>`
        insert into app.needs_attention (tenant_id, company_id, branch_id, terminal_id, client_ref, payload, error_code, error_detail)
        values (${a.tenant}, ${a.company}, ${a.hq}, null, ${clientRef}, ${tx.json({ clientRef })}, 'ERR_RBAC_FORBIDDEN', 'cashier lacks pos.ticket.sell')
        returning id, resolved_by`;
      expect(row!.resolved_by).toBeNull(); // stamp_actor leaves a NULL insert alone (plan0A:2370-2376)
      return row!.id;
    });

    const [resolved] = await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx<{ resolved_by: string }[]>`
      update app.needs_attention set resolved_by = ${b.human}, resolved_at = now() where id = ${id} returning resolved_by`,
    );
    // The supplied id was DISCARDED and replaced with the session actor: that is the whole point of stamp_actor.
    expect(resolved!.resolved_by).toBe(a.human);
    expect(resolved!.resolved_by).not.toBe(b.human);
  });

  it("a second tenant sees neither table (test 12 for the two new tables)", async () => {
    const seenEnrol = await withTenant(
      db.rw,
      b.tenant,
      b.human,
      (tx) => tx<{ n: number }[]>`
      select count(*)::int as n from app.terminal_enrolment`,
    );
    const seenNa = await withTenant(
      db.rw,
      b.tenant,
      b.human,
      (tx) => tx<{ n: number }[]>`
      select count(*)::int as n from app.needs_attention`,
    );
    expect(seenEnrol[0]!.n).toBe(0);
    expect(seenNa[0]!.n).toBe(0);
  });

  // PR 12 review, finding 14. The plain `unique (company_id, terminal_code)` this replaced held a code for ever
  // from the moment it was issued, and app_rw cannot delete an enrolment — so one code nobody redeemed inside
  // its hour burned that terminal code for the company.
  describe("the terminal code is held by a live or redeemed enrolment, and released when one expires unredeemed", () => {
    const issue = (code: string) =>
      withTenant(db.rw, a.tenant, a.human, (tx) =>
        createEnrolment(tx, ctx(a), {
          companyId: a.company,
          branchId: a.hq,
          name: `Till ${code}`,
          terminalCode: code,
        }),
      );
    const conflict = async (code: string): Promise<void> => {
      const refused = await issue(code).catch((e: unknown) => e);
      expect(refused).toBeInstanceOf(SyncError);
      expect((refused as SyncError).code).toBe("ERR_CONFLICT_UNIQUE");
    };
    // What a till that never redeemed inside its hour leaves behind: the row is moved two hours back in time.
    const expire = (enrolmentId: string) =>
      withTenant(
        db.rw,
        a.tenant,
        a.human,
        (tx) =>
          tx`update app.terminal_enrolment
              set created_at = now() - interval '2 hours', expires_at = now() - interval '1 hour'
            where id = ${enrolmentId}`,
      );

    it("an expired, never-redeemed enrolment no longer blocks re-issuing its terminal code", async () => {
      const first = await issue("KL01");
      await conflict("KL01"); // live: still held
      await expire(first.enrolmentId);
      const second = await issue("KL01");
      expect(second.enrolmentId).not.toBe(first.enrolmentId);
      // And the re-issued one holds the code in its turn.
      await conflict("KL01");
    });

    it("a redeemed enrolment holds its terminal code for ever, expired or not", async () => {
      const issued = await issue("KL02");
      await withTenant(
        db.rw,
        a.tenant,
        a.human,
        (tx) =>
          tx`update app.terminal_enrolment set redeemed_at = now() where id = ${issued.enrolmentId}`,
      );
      await expire(issued.enrolmentId);
      await conflict("KL02");
    });

    it("two concurrent issues of one code: exactly one commits", async () => {
      const outcomes = await Promise.allSettled([issue("KL03"), issue("KL03")]);
      expect(outcomes.map((o) => o.status).toSorted()).toEqual(["fulfilled", "rejected"]);
      const refused = outcomes.find((o) => o.status === "rejected") as PromiseRejectedResult;
      expect((refused.reason as SyncError).code).toBe("ERR_CONFLICT_UNIQUE");
      const [held] = await db.admin<{ n: number }[]>`
        select count(*)::int as n from app.terminal_enrolment where company_id = ${a.company} and terminal_code = 'KL03'`;
      expect(held!.n).toBe(1);
    });

    it("the same code in another company is a different holding", async () => {
      await issue("KL04");
      await withTenant(db.rw, b.tenant, b.human, (tx) =>
        createEnrolment(tx, ctx(b), {
          companyId: b.company,
          branchId: b.hq,
          name: "Till KL04",
          terminalCode: "KL04",
        }),
      );
    });
  });

  // PR 12 review, extra finding E1: a signed sync request is spent once inside the clock window.
  describe("terminal_request_guard — each signed message is spent once", () => {
    let terminal: { terminalId: string; principalId: string };
    beforeAll(async () => {
      terminal = await seedTerminal(db, a, { code: "G1" });
    }, 180_000);
    const claim = (digest: string, signedAt = new Date().toISOString()) =>
      withTenant(db.rw, a.tenant, terminal.principalId, (tx) =>
        claimSignedRequest(tx, {
          tenantId: a.tenant,
          terminalId: terminal.terminalId,
          digest,
          signedAt,
          windowSeconds: 300,
        }),
      );

    it("refuses the same message twice and admits distinct messages in either order", async () => {
      expect(await claim("a".repeat(64))).toBe(true);
      expect(await claim("a".repeat(64))).toBe(false);
      expect(await claim("c".repeat(64))).toBe(true);
      expect(await claim("b".repeat(64))).toBe(true); // an earlier-sorting digest after a later one: no ordering
    });

    it("two concurrent copies of one message: exactly one is admitted", async () => {
      const answers = await Promise.all([claim("d".repeat(64)), claim("d".repeat(64))]);
      expect(answers.toSorted()).toEqual([false, true]);
      const distinct = await Promise.all([claim("e".repeat(64)), claim("f".repeat(64))]);
      expect(distinct).toEqual([true, true]);
    });

    it("prunes entries past twice the window on the next write, so the row stays bounded", async () => {
      const old = new Date(Date.now() - 11 * 60_000).toISOString();
      expect(await claim("0".repeat(64), old)).toBe(true);
      expect(await claim("1".repeat(64))).toBe(true);
      const [row] = await db.admin<{ seen: Record<string, string> }[]>`
        select seen from app.terminal_request_guard where terminal_id = ${terminal.terminalId}`;
      expect(Object.keys(row!.seen)).not.toContain("0".repeat(64));
      expect(Object.keys(row!.seen)).toContain("1".repeat(64));
    });

    it("a second tenant sees no guard row and cannot write one for another tenant's terminal", async () => {
      const [seen] = await withTenant(
        db.rw,
        b.tenant,
        b.human,
        (tx) => tx<{ n: number }[]>`select count(*)::int as n from app.terminal_request_guard`,
      );
      expect(seen!.n).toBe(0);
      await expect(
        withTenant(db.rw, b.tenant, b.human, (tx) =>
          claimSignedRequest(tx, {
            tenantId: a.tenant,
            terminalId: terminal.terminalId,
            digest: "9".repeat(64),
            signedAt: new Date().toISOString(),
            windowSeconds: 300,
          }),
        ),
      ).rejects.toThrow();
    });
  });

  it("the schema linter still reports zero violations", async () => {
    expect(await lintSchema(db.admin)).toEqual([]);
  });
});
