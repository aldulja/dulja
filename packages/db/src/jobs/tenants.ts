import type { Sql } from "postgres";

/**
 * Runs `fn` for every registered tenant with bounded concurrency, then reports every failure at once.
 *
 * `concurrency` defaults to one fewer than the pool's own `max` — three on the `createDb` default of four.
 * As the tree stands a tenant's job holds exactly one connection at a time: `runJob` awaits `systemContext`
 * on the pool and has that connection back before the handler opens `withTenant`'s transaction, and
 * `ledgerIntegrityCheck`'s two transactions are sequential. So `max` slots would not in fact deadlock
 * today. Nothing enforces that, though — `withTenant` rejects a nested call only when the *transaction* is
 * handed back in as `sql`, so a handler that closes over the pool inside a `withTenant` callback takes a
 * second connection while holding the first, and `no-bare-db` does not see that shape: it flags a pool
 * handle that tags SQL or has a method called on it, and a nested `withTenant(sql, …)` only passes it as
 * an argument. At one extra connection per slot, `max - 1` slots leave a spare some slot can always take
 * for its second, finish on, and give both back — a progress guarantee rather than head-room, where `max`
 * slots would hang the fan-out outright, every slot holding one connection and waiting for one only a peer
 * can free. What the guarantee rests on is that every *other* user of this pool holds at most one
 * connection and releases it, not that the spare stays untouched: the per-tenant `boss.work` handlers that
 * share the pool may take it, and today they release it, because they reach the database the same way this
 * fan-out's own body does. It is also per call, not per process — `apps/worker/src/index.ts` registers a
 * `.fanout` worker for every scheduled job on one pool, so two overlapping fan-outs are two bounds, not
 * one. A budget spanning them belongs at that call site; this parameter is how it would be spent.
 */
export async function eachTenant(
  sql: Sql,
  fn: (tenantId: string) => Promise<void>,
  opts: { concurrency?: number } = {},
): Promise<void> {
  const rows = await sql<
    { tenant_id: string }[]
  >`select tenant_id from pgboss.tenant_registry order by created_at, tenant_id`;
  // Start order still follows the query — the audit order — because every slot draws from one shared
  // cursor; completion order no longer does. Failures are therefore recorded by row position rather than
  // pushed, so the message below names tenants in registry order on every run. It used to name them in
  // failure order, which was deterministic only because the loop was serial, and that message is what an
  // operator reads at the top of pg-boss's failed row when comparing one night against the last.
  const failures: ({ tenantId: string; error: unknown } | undefined)[] = [];
  let next = 0;
  // A slot resolves whatever `fn` does, which is what makes the `Promise.all` below safe: the
  // short-circuit that would make it wrong here — abandoning the tenants still in flight on the first
  // rejection — needs a rejecting member, and every rejection is caught one tenant at a time.
  const slot = async (): Promise<void> => {
    while (next < rows.length) {
      const index = next++;
      const tenantId = rows[index]!.tenant_id;
      try {
        await fn(tenantId);
      } catch (error) {
        failures[index] = { tenantId, error };
      }
    }
  };
  // A caller's 0, negative or NaN clamps to serial, never to no slots at all: a fan-out that silently
  // skips every tenant is the one outcome worse than a slow one. NaN has to be said separately from the
  // other two, because `Math.max(1, NaN)` is NaN and `Array.from({ length: NaN })` builds no slots — and
  // NaN is exactly the shape a bound read out of an unset environment variable arrives in.
  const requested = opts.concurrency ?? sql.options.max - 1;
  const slots = Math.min(Number.isNaN(requested) ? 1 : Math.max(1, requested), rows.length);
  await Promise.all(Array.from({ length: slots }, slot));
  const failed = failures.filter((failure) => failure !== undefined);
  if (failed.length > 0)
    throw new AggregateError(
      failed.map((failure) => failure.error),
      `job failed for ${failed.length} tenant(s): ${failed.map((failure) => failure.tenantId).join(", ")}`,
    );
}
