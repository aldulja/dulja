import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { lintSchema } from "../src/lint-schema";
import { down, up } from "../src/migrate";
import { MIGRATIONS_DIR, startDb, type Db } from "./harness";
import postgres, { type Sql } from "postgres";
import type { PgBoss } from "pg-boss";
import {
  createJobClient,
  JOB_NAMES,
  JobNotInsertedError,
  JOBS,
  queuePolicy,
  startEnqueueClient,
  STATELY_JOBS,
  type JobClient,
} from "../src/jobs/enqueue";
import { eachTenant } from "../src/jobs/tenants";
import { seedTenant, type Seed } from "./fixtures";
import { installBoss, stopBoss } from "./boss";
import { withTenant as testWithTenant, uuidv7 } from "./harness";

/** Long enough to keep a slot occupied while its peers start; module-scoped because it captures nothing. */
const pause = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

describe("migration 0004 — the pgboss schema (contracts §4.2.6; spec §3.2.2)", () => {
  let db: Db;
  beforeAll(async () => {
    db = await startDb();
  });
  afterAll(async () => {
    await db.stop();
  });

  it("creates schema pgboss with USAGE for app_rw", async () => {
    const [row] = await db.admin<{ n: number }[]>`
      select count(*)::int as n
        from information_schema.schemata
       where schema_name = 'pgboss'
    `;
    expect(row!.n).toBe(1);
    const [priv] = await db.admin<{ ok: boolean }[]>`
      select has_schema_privilege('app_rw', 'pgboss', 'usage') as ok
    `;
    expect(priv!.ok).toBe(true);
  });

  it("app_rw may not create objects in pgboss — pg-boss's own tables are installed by app_migrator", async () => {
    const [priv] = await db.admin<{ ok: boolean }[]>`
      select has_schema_privilege('app_rw', 'pgboss', 'create') as ok
    `;
    expect(priv!.ok).toBe(false);
    await expect(db.rw`create table pgboss.rogue (id int)`).rejects.toThrow(/permission denied/);
  });

  it("default privileges give app_rw full DML on tables app_migrator creates there, and none elsewhere", async () => {
    const rows = await db.admin<{ defaclobjtype: string; privs: string }[]>`
      select d.defaclobjtype::text, array_to_string(d.defaclacl::text[], ',') as privs
        from pg_default_acl d
        join pg_namespace n on n.oid = d.defaclnamespace
       where n.nspname = 'pgboss'
       order by d.defaclobjtype::text collate "C"
    `;
    expect(rows.map((r) => r.defaclobjtype)).toEqual(["S", "r"]);
    expect(rows.find((r) => r.defaclobjtype === "r")!.privs).toMatch(/app_rw=arwd/);
    expect(rows.find((r) => r.defaclobjtype === "S")!.privs).toMatch(/app_rw=rU/);
  });

  it("pgboss.tenant_registry exists, is readable by app_rw with no tenant set, and is not in schema app", async () => {
    await db.migrator`
      insert into pgboss.tenant_registry (tenant_id)
      values ('01920000-0000-7000-8000-000000000001')
    `;
    const rows = await db.rw<{ tenant_id: string }[]>`
      select tenant_id from pgboss.tenant_registry order by tenant_id
    `;
    expect(rows).toHaveLength(1);
    const [app] = await db.admin<{ n: number }[]>`
      select count(*)::int as n
        from information_schema.tables
       where table_schema = 'app'
         and table_name = 'tenant_registry'
    `;
    expect(app!.n).toBe(0);
  });

  it("the schema linter still reports zero violations — pgboss is outside schema app", async () => {
    expect(await lintSchema(db.admin)).toEqual([]);
  });

  it("the down file removes the schema and its default privileges completely", async () => {
    await down(db.migrator, MIGRATIONS_DIR, 3);
    const [row] = await db.admin<{ n: number }[]>`
      select count(*)::int as n
        from information_schema.schemata
       where schema_name = 'pgboss'
    `;
    expect(row!.n).toBe(0);
    const [acl] = await db.admin<{ n: number }[]>`
      select count(*)::int as n
        from pg_default_acl d
        join pg_namespace n on n.oid = d.defaclnamespace
       where n.nspname = 'pgboss'
    `;
    expect(acl!.n).toBe(0);
    expect(await up(db.migrator, MIGRATIONS_DIR)).toEqual(expect.arrayContaining([4]));
  });
});

describe("transactional enqueue — spec §5.0 row 0.11, §3.2.2 (SAH-005)", () => {
  let db: Db;
  let boss: PgBoss;
  let jobs: JobClient;
  let a: Seed;
  let b: Seed;

  beforeAll(async () => {
    db = await startDb();
    a = await seedTenant(db, "Alpha");
    b = await seedTenant(db, "Beta");
    boss = await installBoss(db, Object.keys(JOBS));
    jobs = createJobClient(boss);
  });
  afterAll(async () => {
    await stopBoss(boss);
    await db.stop();
  });

  const queued = async (name: string): Promise<number> => {
    const [row] = await db.admin<
      { n: number }[]
    >`select count(*)::int as n from pgboss.job where name = ${name}`;
    return row!.n;
  };

  it("a job enqueued in a transaction that COMMITS is queued exactly once", async () => {
    const requestId = await uuidv7(db.admin);
    const id = await testWithTenant(db.rw, a.tenant, a.system, (tx) =>
      jobs.enqueue(tx, "admin.idempotency_key.purge", {
        tenantId: a.tenant,
        requestId,
        payload: {},
      }),
    );
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(await queued("admin.idempotency_key.purge")).toBe(1);
  });

  it("a job enqueued in a transaction that ROLLS BACK never exists (DoD 0.11)", async () => {
    const before = await queued("accounting.ledger.integrity_check");
    const requestId = await uuidv7(db.admin);
    await expect(
      testWithTenant(db.rw, a.tenant, a.system, async (tx) => {
        await jobs.enqueue(tx, "accounting.ledger.integrity_check", {
          tenantId: a.tenant,
          requestId,
          payload: {},
        });
        throw new Error("deliberate rollback");
      }),
    ).rejects.toThrow("deliberate rollback");
    expect(await queued("accounting.ledger.integrity_check")).toBe(before);
  });

  it("the job is invisible until the enclosing transaction commits", async () => {
    const requestId = await uuidv7(db.admin);
    await testWithTenant(db.rw, a.tenant, a.system, async (tx) => {
      // 3B amendment A9 types this payload; it was `unknown` while JobPayload carried no 3B key. The replay's
      // queue is stately, so the company key is required (§4.2.6).
      await jobs.enqueue(
        tx,
        "inventory.cost.replay",
        { tenantId: a.tenant, requestId, payload: { companyId: a.company } },
        { singletonKey: a.company },
      );
      expect(await queued("inventory.cost.replay")).toBe(0);
    });
    expect(await queued("inventory.cost.replay")).toBe(1);
  });

  it("the API's send-only client runs as app_rw and enqueues on the CALLER's transaction", async () => {
    // apps/api/src/index.ts builds its JobClient with this: no workers, no maintenance, no migrate — the
    // tables were installed as app_migrator above, exactly as the deploy step does.
    const client = await startEnqueueClient(db.url("app_rw"));
    try {
      const requestId = await uuidv7(db.admin);
      const before = await queued("inventory.cost.replay");
      // Tenant b's company: tenant a's replay from the case above is still queued, and a second request for
      // its key would collapse into it (§4.2.6), so it could not show an insert landing on this transaction.
      const job = { tenantId: b.tenant, requestId, payload: { companyId: b.company } };
      await expect(
        testWithTenant(db.rw, b.tenant, b.system, async (tx) => {
          await client.jobs.enqueue(tx, "inventory.cost.replay", job, {
            singletonKey: b.company,
          });
          throw new Error("deliberate rollback");
        }),
      ).rejects.toThrow("deliberate rollback");
      expect(await queued("inventory.cost.replay")).toBe(before);
      await testWithTenant(db.rw, b.tenant, b.system, (tx) =>
        client.jobs.enqueue(tx, "inventory.cost.replay", job, { singletonKey: b.company }),
      );
      expect(await queued("inventory.cost.replay")).toBe(before + 1);
    } finally {
      await client.stop();
    }
  });

  it("the envelope carries tenantId and requestId, and they survive the round trip", async () => {
    const requestId = await uuidv7(db.admin);
    await testWithTenant(db.rw, b.tenant, b.system, (tx) =>
      jobs.enqueue(tx, "accounting.period.month_end", {
        tenantId: b.tenant,
        requestId,
        payload: {},
      }),
    );
    const [row] = await db.admin<{ data: { tenantId: string; requestId: string } }[]>`
      select data from pgboss.job where name = 'accounting.period.month_end' limit 1`;
    expect(row!.data).toMatchObject({ tenantId: b.tenant, requestId });
  });

  it("JOBS is the closed registry of every v1 job name, each with a schedule field and an owning slice", () => {
    expect(Object.keys(JOBS)).toHaveLength(16);
    expect(Object.keys(JOBS)).toContain("accounting.ledger.integrity_check");
    expect(JOBS["admin.idempotency_key.purge"]).toEqual({ schedule: "*/30 * * * *", owner: "0D" });
    for (const [name, def] of Object.entries(JOBS)) {
      // The plan wrote this as a strict three-segment grammar, but 0B's frozen registry — which this slice
      // verifies rather than rewrites — already ships the two-segment `reporting.render`, so the third
      // segment is optional here. Tighten the regex only by amending the registry first.
      expect(name, name).toMatch(
        /^(accounting|inventory|admin|pos|reporting|hr)\.[a-z_]+(?:\.[a-z_]+)?$/,
      );
      expect(def.schedule === null || /^[\d*/,\- ]+$/.test(def.schedule), name).toBe(true);
    }
  });

  it("eachTenant iterates pgboss.tenant_registry with no tenant set — the FORCE RLS work-around", async () => {
    await db.migrator`insert into pgboss.tenant_registry (tenant_id) values (${a.tenant}), (${b.tenant}) on conflict do nothing`;
    const seen: string[] = [];
    await eachTenant(db.rw, async (tenantId) => {
      seen.push(tenantId);
    });
    expect(seen.toSorted()).toEqual([a.tenant, b.tenant].toSorted());
  });

  // The registry is shared with the membership assertion above, which names a and b exactly, so these
  // cases append to it and derive every expectation from what `eachTenant` itself would read. One insert
  // per row on purpose: created_at defaults to now(), which is the transaction timestamp, so a single
  // multi-row insert ties every row and hands the audit order to the uuid tiebreak instead.
  const registerTenants = async (count: number): Promise<void> => {
    for (let n = 0; n < count; n += 1) {
      const id = await uuidv7(db.admin);
      await db.migrator`insert into pgboss.tenant_registry (tenant_id) values (${id})`;
    }
  };
  const registryOrder = async (): Promise<string[]> => {
    const rows = await db.admin<{ tenant_id: string }[]>`
      select tenant_id from pgboss.tenant_registry order by created_at, tenant_id`;
    return rows.map((row) => row.tenant_id);
  };
  // Every slot is created before any of them resolves, so the peak is reached in the first synchronous
  // burst and needs no barrier to be stable.
  const observe = async (
    pool: Sql,
    opts?: { concurrency?: number },
  ): Promise<{ seen: string[]; peak: number }> => {
    const seen: string[] = [];
    let inFlight = 0;
    let peak = 0;
    await eachTenant(
      pool,
      async (tenantId) => {
        seen.push(tenantId);
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await pause();
        inFlight -= 1;
      },
      opts,
    );
    return { seen, peak };
  };

  it("eachTenant runs tenants in parallel up to the bound, and starts them in registry order", async () => {
    await registerTenants(5);
    const order = await registryOrder();
    const { seen, peak } = await observe(db.rw, { concurrency: 2 });
    // Exactly the bound, not at most it: `<=` is true of the serial loop this replaced as well, so only
    // the equality tells bounded concurrency apart from no concurrency at all.
    expect(peak).toBe(2);
    expect(seen).toEqual(order);
  });

  it("the default bound is one fewer than the pool's max — the connection a slot may still need", async () => {
    await registerTenants(7);
    // A second pool at a different max, because db.rw's four cannot tell the derivation apart from a
    // literal three. It is app_rw over the same container, and ended here rather than in afterAll so it
    // never outlives the case that opened it.
    const wide = postgres(db.url("app_rw"), { max: 6, onnotice: () => {} });
    try {
      expect((await observe(db.rw)).peak).toBe(db.rw.options.max - 1);
      expect((await observe(wide)).peak).toBe(5);
    } finally {
      await wide.end();
    }
  });

  it("a concurrency of zero runs serially rather than skipping every tenant", async () => {
    await registerTenants(3);
    const order = await registryOrder();
    const { seen, peak } = await observe(db.rw, { concurrency: 0 });
    expect(peak).toBe(1);
    expect(seen).toEqual(order);
  });

  // No `registerTenants` here: the clamp is about how many slots a bound opens, not how many rows there
  // are, and the seventeen the cases above left behind are more than either bound can be confused by.
  it("a NaN concurrency runs serially too — Math.max would carry it through to zero slots", async () => {
    const order = await registryOrder();
    const { seen, peak } = await observe(db.rw, { concurrency: Number.NaN });
    expect(peak).toBe(1);
    expect(seen).toEqual(order);
  });

  it("a tenant that throws stops neither its peers in flight nor the tenants after it", async () => {
    await registerTenants(4);
    const order = await registryOrder();
    const doomed = order[1]!;
    const seen: string[] = [];
    let inFlight = 0;
    let peersWhenItFailed = -1;
    await expect(
      eachTenant(
        db.rw,
        async (tenantId) => {
          seen.push(tenantId);
          inFlight += 1;
          try {
            // The serial loop had finished every earlier tenant before this one started, so a peer still
            // in flight at the throw is exactly what the concurrent implementation buys — and exactly
            // what a `Promise.all` over `rows.map(fn)` would then abandon.
            if (tenantId === doomed) {
              peersWhenItFailed = inFlight - 1;
              throw new Error(`boom ${tenantId}`);
            }
            await pause();
          } finally {
            inFlight -= 1;
          }
        },
        { concurrency: 3 },
      ),
    ).rejects.toThrow(AggregateError);
    expect(peersWhenItFailed).toBeGreaterThanOrEqual(1);
    expect(seen.toSorted()).toEqual(order.toSorted());
  });

  it("the AggregateError names every failure, in registry order and not in the order they failed", async () => {
    await registerTenants(4);
    const order = await registryOrder();
    const [early, late] = [order[0]!, order[2]!];
    let caught: unknown;
    try {
      // `early` fails last in wall-clock and `late` fails first, so failure order and registry order
      // disagree here and the message can only satisfy one of them.
      await eachTenant(
        db.rw,
        async (tenantId) => {
          if (tenantId === early) {
            await pause();
            await pause();
            throw new Error(`boom ${tenantId}`);
          }
          if (tenantId === late) throw new Error(`boom ${tenantId}`);
          await pause();
        },
        { concurrency: 3 },
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AggregateError);
    const aggregate = caught as AggregateError;
    expect(aggregate.message).toBe(`job failed for 2 tenant(s): ${early}, ${late}`);
    expect((aggregate.errors as Error[]).map((error) => error.message)).toEqual([
      `boom ${early}`,
      `boom ${late}`,
    ]);
  });
});

describe("stately queues — one QUEUED job per key, never collapsed into an ACTIVE one (contracts §4.2.6)", () => {
  // pg-boss 12's `stately` policy is a unique index over (name, state, coalesce(singleton_key, '')) where
  // state <= 'active' (job_i3), so a key holds at most one `created` and one `active` job; `send` is
  // INSERT … ON CONFLICT DO NOTHING. Each case uses a fresh key, and the queue is emptied after it, because
  // `boss.fetch` claims whichever job of the queue is next — not one of a given key.
  const NAME = "accounting.projection.rebuild";
  let db: Db;
  let boss: PgBoss;
  let jobs: JobClient;
  let a: Seed;

  beforeAll(async () => {
    db = await startDb();
    a = await seedTenant(db, "Alpha");
    boss = await installBoss(db, Object.keys(JOBS));
    jobs = createJobClient(boss);
  });
  afterEach(async () => {
    await db.admin`delete from pgboss.job where name in (${NAME}, 'accounting.tax.submit')`;
  });
  afterAll(async () => {
    await stopBoss(boss);
    await db.stop();
  });

  // The key stands for a company; these jobs are never run, so no company row is needed behind it.
  const envelope = (key: string) => ({
    tenantId: a.tenant,
    requestId: key,
    payload: { companyId: key },
  });
  const enqueue = (key: string): Promise<string> =>
    testWithTenant(db.rw, a.tenant, a.system, (tx) =>
      jobs.enqueue(tx, NAME, envelope(key), { singletonKey: key }),
    );
  const rows = (key: string) =>
    db.admin<{ id: string; state: string }[]>`
      select id::text as id, state::text as state from pgboss.job
       where name = ${NAME} and singleton_key = ${key} order by created_on, state`;

  it("the install gives STATELY_JOBS' queues the stately policy and every other queue the standard one", async () => {
    expect(STATELY_JOBS.toSorted()).toEqual([
      "accounting.projection.rebuild",
      "accounting.tax.submit",
      "inventory.cost.replay",
    ]);
    for (const name of JOB_NAMES) {
      const queue = await boss.getQueue(name);
      expect(queue?.policy, name).toBe(queuePolicy(name));
    }
    expect(queuePolicy("inventory.cost.replay")).toBe("stately");
    expect(queuePolicy("accounting.projection.rebuild.fanout")).toBe("standard");
  });

  it("a request while one is QUEUED collapses into it: both commit, one job, and both return its id", async () => {
    const key = await uuidv7(db.admin);
    const first = await enqueue(key);
    const second = await enqueue(key);
    expect(second).toBe(first);
    expect(await rows(key)).toEqual([{ id: first, state: "created" }]);
  });

  it("a request after the job COMPLETED queues a new one — no 24-hour slot outlives the job", async () => {
    // The defect: `singletonSeconds = 86400` put every keyed job in a throttle slot whose unique index
    // (job_i4) counts every state but cancelled, so this second request threw JobNotInsertedError all day.
    const key = await uuidv7(db.admin);
    const first = await enqueue(key);
    const [claimed] = await boss.fetch(NAME);
    expect(claimed?.id).toBe(first);
    await boss.complete(NAME, first);
    const second = await enqueue(key);
    expect(second).not.toBe(first);
    expect(await rows(key)).toEqual([
      { id: first, state: "completed" },
      { id: second, state: "created" },
    ]);
  });

  it("a request while one is ACTIVE queues a second job, which waits until the first settles", async () => {
    const key = await uuidv7(db.admin);
    const first = await enqueue(key);
    const [active] = await boss.fetch(NAME);
    expect(active?.id).toBe(first);
    // The running job may already have read the state this request changed, so it is not collapsed into.
    const second = await enqueue(key);
    expect(second).not.toBe(first);
    // …and a third collapses into the QUEUED one, never into the active one.
    expect(await enqueue(key)).toBe(second);
    // At most one active job per key: the claim of the queued one fails while the first runs.
    expect(await boss.fetch(NAME)).toEqual([]);
    await boss.complete(NAME, first);
    const [next] = await boss.fetch(NAME);
    expect(next?.id).toBe(second);
  });

  it("an active tax poll can schedule its successor, and duplicate polls collapse", async () => {
    const key = await uuidv7(db.admin);
    const taxJob = (verb: "submit" | "poll") => ({
      tenantId: a.tenant,
      requestId: key,
      payload: { transmissionId: key, phase: verb },
    });
    const send = (verb: "submit" | "poll") =>
      testWithTenant(db.rw, a.tenant, a.system, (tx) =>
        jobs.enqueue(tx, "accounting.tax.submit", taxJob(verb), { singletonKey: key }),
      );
    const first = await send("poll");
    const [active] = await boss.fetch("accounting.tax.submit");
    expect(active?.id).toBe(first);
    const poll = await send("poll");
    expect(poll).not.toBe(first);
    expect(await send("poll")).toBe(poll);
    expect(await boss.fetch("accounting.tax.submit")).toEqual([]);
    await boss.complete("accounting.tax.submit", first);
    const [next] = await boss.fetch("accounting.tax.submit");
    expect(next?.id).toBe(poll);
    expect(next?.data).toEqual(taxJob("poll"));
  });

  it("a collapsing transaction holds the queued job until it commits, so the job cannot start without its work", async () => {
    const key = await uuidv7(db.admin);
    const queued = await enqueue(key);
    let claimedInside: unknown[] = ["not fetched"];
    const collapsed = await testWithTenant(db.rw, a.tenant, a.system, async (tx) => {
      const id = await jobs.enqueue(tx, NAME, envelope(key), { singletonKey: key });
      // A worker polling now, on its own connection. Had it claimed the job, the job would read the
      // company's state without this transaction's writes and nothing would come back for them.
      claimedInside = await boss.fetch(NAME);
      return id;
    });
    expect(collapsed).toBe(queued);
    expect(claimedInside).toEqual([]);
    const [claimed] = await boss.fetch(NAME);
    expect(claimed?.id).toBe(queued);
  });

  it("a collapse that rolls back releases the queued job, which is still there and claimable", async () => {
    const key = await uuidv7(db.admin);
    const queued = await enqueue(key);
    await expect(
      testWithTenant(db.rw, a.tenant, a.system, async (tx) => {
        await jobs.enqueue(tx, NAME, envelope(key), { singletonKey: key });
        throw new Error("deliberate rollback");
      }),
    ).rejects.toThrow("deliberate rollback");
    expect(await rows(key)).toEqual([{ id: queued, state: "created" }]);
    const [claimed] = await boss.fetch(NAME);
    expect(claimed?.id).toBe(queued);
  });

  it("a stately job without a singletonKey is refused — keyless, every tenant's would share one slot", async () => {
    const key = await uuidv7(db.admin);
    await expect(
      testWithTenant(db.rw, a.tenant, a.system, (tx) => jobs.enqueue(tx, NAME, envelope(key))),
    ).rejects.toThrow(/stately queue and needs a singletonKey/);
    expect(await rows(key)).toEqual([]);
  });

  it("a keyed STANDARD job keeps 0D's 24-hour slot: the second is refused with JobNotInsertedError", async () => {
    const key = await uuidv7(db.admin);
    const job = { tenantId: a.tenant, requestId: key, payload: {} };
    await testWithTenant(db.rw, a.tenant, a.system, (tx) =>
      jobs.enqueue(tx, "accounting.period.month_end", job, { singletonKey: key }),
    );
    await expect(
      testWithTenant(db.rw, a.tenant, a.system, (tx) =>
        jobs.enqueue(tx, "accounting.period.month_end", job, { singletonKey: key }),
      ),
    ).rejects.toBeInstanceOf(JobNotInsertedError);
  });
});
