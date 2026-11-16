import { thinRegression, sliceRegression } from "../support/regression";
import { seedTenantV2, uuidv7 } from "@dulja/db/test";

thinRegression(
  "LEGACY-023",
  "Audit sequence numbers are renumbered retroactively and collide across document classes",
  "packages/db/test/audit.test.ts",
  async ({ db, rw, a, withTenant, expect }) => {
    const ctx = { tenantId: a.tenant, actorId: a.human, requestId: "legacy-023" };
    const seqOf = async (): Promise<number> => {
      const [row] = await db.admin<{ seq: string }[]>`
        select coalesce(max(seq), 0)::text as seq from app.audit_log where tenant_id = ${a.tenant}`;
      return Number(row!.seq);
    };
    const before = await seqOf();
    await withTenant(
      rw,
      ctx,
      (tx) =>
        tx`insert into app.company (tenant_id, code, name, base_currency) values (${a.tenant}, 'LEGACY023A', 'A', 'MYR')`,
    );
    const mid = await seqOf();
    await withTenant(
      rw,
      ctx,
      (tx) =>
        tx`insert into app.company (tenant_id, code, name, base_currency) values (${a.tenant}, 'LEGACY023B', 'B', 'MYR')`,
    );
    const after = await seqOf();
    expect(mid).toBeGreaterThan(before);
    expect(after).toBeGreaterThan(mid); // one ascending stream, never renumbered

    // `seq` cannot be supplied or rewritten, so it cannot be renumbered afterwards, and it is one stream per
    // table — not one per document class that could collide with another. Until 0125 that was a generated
    // identity; since DBS-02 (ADR 0094) `app.audit_chain()` draws it under the tenant lock and overwrites any
    // supplied value — proven by the review block at the end of this file.
    const [priv] = await db.admin<{ upd: boolean }[]>`
      select has_column_privilege('app_rw', 'app.audit_log', 'seq', 'update') as upd`;
    expect(priv!.upd).toBe(false);
  },
);

// ─── 2B ──────────────────────────────────────────────────────────────────────────────────────────────────
// contracts §3.7.3: 0B created this file; a later slice appends and never edits the block above.
sliceRegression(
  "LEGACY-023",
  "Audit sequence numbers are renumbered retroactively and collide across document classes",
  "2B",
  "document_event has no per-class counter to renumber: identity is a time-ordered uuidv7 and nothing else",
  async ({ db, expect }) => {
    const s = await seedTenantV2(db, "LEGACY023-2B");
    // The legacy defect was two procedures (procVouAuditID, procBilAuditID) both restarting at 1 and both
    // feeding one column, so inserting a back-dated voucher shifted every later document's audit number.
    // Here there IS no number: the lifecycle record is keyed by uuidv7 and ordered by it.
    // A counter is a whole number. 0045's `approved_base_total numeric(19,4)` (code review 2026-09-29) is a
    // money amount a credit override approved, not a number anything renumbers, so a scaled numeric is not one.
    const numeric = await db.admin<{ column_name: string }[]>`
      select column_name from information_schema.columns
       where table_schema = 'app' and table_name = 'document_event'
         and (data_type in ('integer', 'bigint', 'smallint')
              or (data_type = 'numeric' and coalesce(numeric_scale, 0) = 0))`;
    expect(numeric).toEqual([]);
    const first = await uuidv7(db.admin);
    const second = await uuidv7(db.admin);
    expect(first < second).toBe(true); // lexicographic order is chronological order
    // and the ONE sequence the system does keep — app.audit_log.seq — is per tenant across every table,
    // never per document class (migration 0001's audit_chain; 0B's own block above proves the chain).
    const [audit] = await db.admin<{ n: number }[]>`
      select count(distinct table_name)::int as n from app.audit_log where tenant_id = ${s.tenant}`;
    expect(audit!.n).toBeGreaterThan(0);
  },
);

// ─── Review 2026-11-15 (DBS-02, ADR 0094, migration 0125) ────────────────────────────────────────────────
sliceRegression(
  "LEGACY-023",
  "Audit sequence numbers are renumbered retroactively and collide across document classes",
  "review 2026-11-15",
  "audit_chain() draws seq itself, under the tenant lock, and overwrites any number an inserter supplies",
  async ({ db, a, withTenant, expect }) => {
    // The concurrent-writer fork this closes is reproduced with two connections in
    // packages/db/test/audit.test.ts ("keeps one unbroken chain when two transactions in a tenant write at once").
    // Here: the position is the trigger's, not the inserter's. app_migrator is the one role that can insert into
    // app.audit_log directly; it asks for seq 1 and the row lands past every stored seq. Rolled back, so nothing
    // is written; no trigger is touched.
    const ctx = { tenantId: a.tenant, actorId: a.system, requestId: "legacy-023-review" };
    class RolledBack extends Error {}
    let landed = 0n;
    let highest = 0n;
    await withTenant(db.migrator, ctx, async (tx) => {
      const [max] = await tx<
        { seq: string }[]
      >`select coalesce(max(seq), 0)::text as seq from app.audit_log`;
      highest = BigInt(max!.seq);
      const [row] = await tx<{ seq: string }[]>`
        insert into app.audit_log (seq, tenant_id, actor_id, table_name, row_id, action, after)
        values (1, ${a.tenant}, ${a.system}, 'legacy023', 'x', 'insert', '{}'::jsonb) returning seq::text as seq`;
      landed = BigInt(row!.seq);
      throw new RolledBack();
    }).catch((error: unknown) => {
      if (!(error instanceof RolledBack)) throw error;
    });
    expect(landed).toBeGreaterThan(highest);
    expect(landed).not.toBe(1n);
  },
);
