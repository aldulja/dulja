import { grantCodes } from "./fixtures";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { verifyChain } from "../src/audit/verify-chain";
import { down, up } from "../src/migrate";
import { draftDocument, seedTenant, type Seed } from "./fixtures";
import { MIGRATIONS_DIR, startDb, type Db, uuidv7, withTenant } from "./harness";

interface AuditRow {
  seq: number;
  actor_id: string;
  table_name: string;
  row_id: string;
  action: string;
  before: { name?: string } | null;
  after: { name?: string } | null;
}

// The chain walk below is the one `apps/worker` ships, imported rather than restated. A second copy of the
// preimage here was a second thing to keep in step with `app.audit_chain()` — exactly the drift migration 0010's
// header warns about — and a copy that agrees with the trigger by construction proves nothing about the verifier
// that actually runs nightly.

// Two of this suite's invariants are proven once, elsewhere, and are deliberately not repeated here:
// actor columns stamped from the session and frozen afterwards — tests/regression/legacy-044.test.ts;
// audit rows unchangeable — tests/regression/legacy-041.test.ts for the shared forbid_change() trigger and
// tests/regression/legacy-029.test.ts for app_rw holding neither UPDATE nor DELETE on app.audit_log. That
// the trigger is attached to audit_log itself, and so answers even a superuser, is proven by
// apps/worker/test/ledger-integrity-check.test.ts ("the immutable trigger rejects an attempted tamper").
describe("audit log — append-only, actor-stamped and tenant chained", () => {
  let db: Db;
  let seed: Seed;

  beforeAll(async () => {
    db = await startDb();
    seed = await seedTenant(db, "Alpha");
    await grantCodes(db, seed); // 6C: explicit company-wide branch visibility; no permission codes.
  });
  afterAll(async () => db.stop());

  const auditFor = (tenant: string, actor: string, table: string) =>
    withTenant(
      db.rw,
      tenant,
      actor,
      (tx) => tx<AuditRow[]>`
      select seq, actor_id, table_name, row_id, action, before, after from app.audit_log
       where tenant_id = ${tenant} and table_name = ${table} order by seq`,
    );

  it("audits the seed itself, with the system principal citing itself as actor", async () => {
    const principals = await auditFor(seed.tenant, seed.system, "principal");
    expect(principals).toHaveLength(2);
    expect(principals[0]).toMatchObject({ actor_id: seed.system, action: "insert" });
    // self_id mode: the tenant row is its own tenant. It is audited before its system principal exists,
    // which is what the deferred actor_id foreign key buys.
    expect((await auditFor(seed.tenant, seed.system, "tenant")).map((row) => row.row_id)).toEqual([
      seed.tenant,
    ]);
  });

  it("records an ordinary write with the session actor and row images", async () => {
    const companyId = await uuidv7(db.admin);
    await withTenant(db.rw, seed.tenant, seed.human, async (tx) => {
      await tx`insert into app.company (id, tenant_id, code, name, base_currency) values (${companyId}, ${seed.tenant}, 'BR1', 'Branch 1', 'MYR')`;
      await tx`update app.company set name = 'Branch One' where id = ${companyId}`;
    });
    const rows = await withTenant(
      db.rw,
      seed.tenant,
      seed.system,
      (tx) =>
        tx<
          {
            action: string;
            actor_id: string;
            before: { name: string } | null;
            after: { name: string } | null;
          }[]
        >`
        select action, actor_id, before, after from app.audit_log where row_id = ${companyId} order by seq`,
    );
    expect(rows).toMatchObject([
      { action: "insert", actor_id: seed.human, before: null, after: { name: "Branch 1" } },
      {
        action: "update",
        actor_id: seed.human,
        before: { name: "Branch 1" },
        after: { name: "Branch One" },
      },
    ]);
  });

  it("records the composite key of a join table as row_id", async () => {
    expect(
      (await auditFor(seed.tenant, seed.system, "membership")).map((row) => row.row_id).toSorted(),
    ).toEqual([`${seed.tenant}/${seed.system}`, `${seed.tenant}/${seed.human}`].toSorted());
  });

  it("rejects a tenant write with no session actor", async () => {
    await expect(
      db.rw.begin(async (tx) => {
        await tx`select set_config('app.tenant_id', ${seed.tenant}, true)`;
        await tx`insert into app.company (tenant_id, code, name, base_currency) values (${seed.tenant}, 'ANON', 'Anon', 'MYR')`;
      }),
    ).rejects.toThrow(/null value in column "actor_id"/);
  });

  it("does not permit application code to forge a standalone audit row", async () => {
    await expect(
      withTenant(
        db.rw,
        seed.tenant,
        seed.human,
        (tx) =>
          tx`insert into app.audit_log (tenant_id, actor_id, table_name, row_id, action, hash)
           values (${seed.tenant}, ${seed.system}, 'company', 'forged', 'insert', '\\x00'::bytea)`,
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it("exempts ledger entries while still auditing the document that carries them", async () => {
    const documentId = await draftDocument(db, seed);
    await withTenant(
      db.rw,
      seed.tenant,
      seed.human,
      (tx) => tx`insert into app.ledger_entry
        (tenant_id, company_id, document_id, line_no, account_id, debit, credit, currency, exchange_rate,
         base_debit, base_credit, effective_date, fiscal_period_id, posting_policy_id) values
        (${seed.tenant}, ${seed.company}, ${documentId}, 1, ${seed.cash},  10, 0, 'MYR', 1, 10, 0, '2026-01-15', ${seed.period}, ${seed.policy}),
        (${seed.tenant}, ${seed.company}, ${documentId}, 2, ${seed.sales}, 0, 10, 'MYR', 1, 0, 10, '2026-01-15', ${seed.period}, ${seed.policy})`,
    );
    expect(await auditFor(seed.tenant, seed.system, "ledger_entry")).toEqual([]);
    expect(
      (await auditFor(seed.tenant, seed.system, "document")).some(
        (row) => row.row_id === documentId,
      ),
    ).toBe(true);
  });

  it("links hashes within one tenant and starts another tenant at genesis", async () => {
    // Audited first, and deliberately hostile: the old separator, and the three characters JSON itself has to
    // escape. The canonical preimage is only worth having if the trigger that writes a row and the verifier that
    // recomputes it escape such a name the same way, and this is the row that would expose it if they did not.
    await withTenant(
      db.rw,
      seed.tenant,
      seed.human,
      (tx) => tx`insert into app.company (tenant_id, code, name, base_currency)
        values (${seed.tenant}, 'SEP', ${'a | b " c \\ d'}, 'MYR')`,
    );
    const other = await seedTenant(db, "Beta");
    await grantCodes(db, other); // 6C: explicit company-wide branch visibility; no permission codes.
    const alpha = await withTenant(db.rw, seed.tenant, seed.system, (tx) =>
      verifyChain(tx, seed.tenant),
    );
    const beta = await withTenant(db.rw, other.tenant, other.system, (tx) =>
      verifyChain(tx, other.tenant),
    );
    expect(alpha.rows).toBeGreaterThan(10);
    expect(alpha).toMatchObject({ brokenLinks: 0, badHashes: 0 });
    expect(beta).toMatchObject({ brokenLinks: 0, badHashes: 0 });
    const [first] = await withTenant(
      db.rw,
      other.tenant,
      other.system,
      (tx) =>
        tx<
          { prev_hash: Buffer | null }[]
        >`select prev_hash from app.audit_log where tenant_id = ${other.tenant} order by seq limit 1`,
    );
    expect(first!.prev_hash).toBeNull();
  });

  // The collision migration 0010 closes, and the only shape that can show it. Two committed rows never meet:
  // every hash folds in the one before it, and tenant_id is the preimage's first field, so no two storable
  // records ever share a link. Both probes therefore write at the *same* link and roll back — which is also what
  // holds occurred_at, actor and payload equal while the separator moves. Nothing is disabled to do it: the chain
  // trigger runs, the immutable trigger is untouched, and the rows never commit.
  //
  // The two fields are table_name and row_id, not the before/after pair: those two are jsonb, and a jsonb text
  // form always closes on `"`, `}` or `]`, so a bare `|` can never sit at their boundary. The free text fields
  // are where the old preimage is genuinely ambiguous, and row_id is the one that carries user text in
  // production — `app.audit_row` builds it by `string_agg` over the key columns, and `document_series` keys on
  // `series`, `role_permission` on `permission_code`.
  //
  // Written as app_migrator because app_rw holds no INSERT on app.audit_log (proven two cases above); forced RLS
  // still makes the migrator name a tenant, which is why this goes through withTenant like every other write.
  it("gives two records the same hash only if they are the same record", async () => {
    class RolledBack extends Error {}
    const probe = async (tableName: string, rowId: string) => {
      let probed: { hash: string; prev: string | null } | undefined;
      await withTenant(db.migrator, seed.tenant, seed.system, async (tx) => {
        const [written] = await tx<{ hash: Buffer; prev_hash: Buffer | null }[]>`
          insert into app.audit_log (tenant_id, actor_id, occurred_at, table_name, row_id, action, before, after)
          values (${seed.tenant}, ${seed.system}, '2026-01-15T00:00:00Z'::timestamptz, ${tableName}, ${rowId},
                  'insert', null, ${JSON.stringify({ code: "X" })}::text::jsonb)
          returning hash, prev_hash`;
        probed = {
          hash: written!.hash.toString("hex"),
          prev: written!.prev_hash?.toString("hex") ?? null,
        };
        throw new RolledBack();
      }).catch((error: unknown) => {
        if (!(error instanceof RolledBack)) throw error;
      });
      return probed!;
    };

    const shifted = await probe("company|abc", "def");
    const plain = await probe("company", "abc|def");
    // Without this the inequality below would be free — two different links differ whatever the preimage does.
    expect(shifted.prev).toBe(plain.prev);
    expect(shifted.hash).not.toBe(plain.hash);
  });

  // DBS-02 (2026-11-15 review; ADR 0094, migration 0125). Under 0001/0010 `seq` was an identity value drawn when
  // the row was formed, before the BEFORE trigger took the tenant lock, so a writer that waited on the lock kept
  // the earlier number while linking to whatever committed while it waited: S1 writes A, S2 draws B's number and
  // blocks, S1 writes C and commits, S2 writes B with prev = hash(C) and B < C in seq. The verifier's
  // `lag(hash) over (order by seq)` then reports two broken links on untampered rows, for ever, because the log
  // is immutable. Two real connections reproduce it; nothing is mocked and no trigger is touched.
  it("keeps one unbroken chain when two transactions in a tenant write at once", async () => {
    const insert = (tx: Sql, code: string) =>
      tx`insert into app.company (tenant_id, code, name, base_currency)
           values (${seed.tenant}, ${code}, ${code}, 'MYR')`;
    let releaseFirst!: () => void;
    const firstMayFinish = new Promise<void>((resolve) => (releaseFirst = resolve));
    let firstWrote!: () => void;
    const firstHasWritten = new Promise<void>((resolve) => (firstWrote = resolve));

    const first = withTenant(db.rw, seed.tenant, seed.human, async (tx) => {
      await insert(tx, "RACEA");
      firstWrote();
      await firstMayFinish;
      await insert(tx, "RACEC");
    });
    await firstHasWritten;
    const second = withTenant(db.rw, seed.tenant, seed.human, (tx) => insert(tx, "RACEB"));
    // Wait until the second writer is genuinely parked on the tenant's advisory lock, so the interleaving is the
    // finding's and not a lucky schedule.
    for (let tries = 0; ; tries += 1) {
      const [waiting] = await db.admin<{ n: number }[]>`
        select count(*)::int as n from pg_locks where locktype = 'advisory' and not granted`;
      if (waiting!.n > 0) break;
      if (tries > 200) throw new Error("the second writer never waited on the tenant lock");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    releaseFirst();
    await Promise.all([first, second]);

    const chain = await withTenant(db.rw, seed.tenant, seed.system, (tx) =>
      verifyChain(tx, seed.tenant),
    );
    expect(chain).toMatchObject({ brokenLinks: 0, badHashes: 0 });
    const order = await db.admin<{ code: string }[]>`
      select after->>'code' as code from app.audit_log
       where tenant_id = ${seed.tenant} and table_name = 'company' and after->>'code' like 'RACE%' order by seq`;
    // The waiter's row is placed where it was linked: after both of the first writer's rows.
    expect(order.map((row) => row.code)).toEqual(["RACEA", "RACEC", "RACEB"]);
  });

  // 0010 replaces a function body, so its down has to give 0001's back exactly or up → down → up is not a round
  // trip. Nothing else in the tree can see that: `migrations.test.ts` and `privileges.test.ts` both fingerprint
  // pg_proc by name, owner and security flag and never by prosrc, so a down that paraphrased the body would pass
  // them both. Last in the file deliberately — it returns the ladder to where it found it, but any row hashed
  // inside that window would not verify afterwards, so nothing may be written after this point.
  it("restores 0001's audit_chain body character for character when 0010 is rolled back", async () => {
    const opener = "create function app.audit_chain() returns trigger language plpgsql as $$";
    const foundations = readFileSync(join(MIGRATIONS_DIR, "0001_foundations.sql"), "utf8");
    const start = foundations.indexOf(opener) + opener.length;
    const original = foundations.slice(start, foundations.indexOf("$$;", start));
    const body = async (): Promise<string> => {
      const [fn] = await db.admin<{ prosrc: string }[]>`
        select prosrc from pg_proc where oid = 'app.audit_chain()'::regprocedure`;
      return fn!.prosrc;
    };

    const canonical = await body();
    expect(canonical).toContain("jsonb_build_array");
    expect(canonical).not.toBe(original);

    // Down to 9 unwinds every migration applied after 0010 as well — 0011 onwards landed after this case was
    // written — so the ladder is asserted to end at 10 and to come back up in exactly the order it went down,
    // as `migrations.test.ts` does for 0008. 0010 is the last migration to define app.audit_chain(), so its
    // body at 9 is 0001's whatever else was unwound on the way.
    const rolledBack = await down(db.migrator, MIGRATIONS_DIR, 9);
    expect(rolledBack.at(-1)).toBe(10);
    expect(rolledBack).not.toContain(9);
    expect(await body()).toBe(original);
    expect(await up(db.migrator, MIGRATIONS_DIR)).toEqual(rolledBack.toReversed());
    expect(await body()).toBe(canonical);
  });
});
