import { sliceRegression, thinRegression } from "../support/regression";

thinRegression(
  "LEGACY-071",
  "Tree-integrity checks run a recursive procedure per row inside triggers",
  "packages/db/test/schema-lint.test.ts",
  async ({ db, rw, a, withTenant, expect }) => {
    const ctx = { tenantId: a.tenant, actorId: a.human, requestId: "legacy-071" };
    // No trigger on a hierarchical table calls a recursive routine: the only triggers are the generic audit,
    // stamp and immutability ones. A tree is read with a recursive CTE at query time, never validated row by
    // row inside a write path.
    const triggers = await db.admin<{ tgname: string }[]>`
      select t.tgname from pg_trigger t join pg_class c on c.oid = t.tgrelid
        join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'app' and c.relname = 'account' and not t.tgisinternal order by t.tgname`;
    for (const t of triggers)
      expect(t.tgname).toMatch(/^(audit_row|stamp_[a-z_]+|account_immutable)$/);

    // Scoped to TRIGGER functions, not to every routine: a recursive CTE in a report or a service function is
    // fine and later slices will write them — the defect was running one per row inside a write path.
    // ONE named exception, and only one: 3A's `app.warehouse_no_cycle` (migration 0029, "the only such check
    // in Dulja") is a single CTE walking up from the proposed parent, fired only when `parent_id` changes.
    // The 3A block at the end of this file pins that exception's whole shape — one CTE, no CALL, attached to
    // app.warehouse alone — so excluding it here by name keeps this check strict for every other trigger.
    const recursive = await db.admin<{ proname: string }[]>`
      select distinct p.proname from pg_trigger t
        join pg_proc p on p.oid = t.tgfoid
        join pg_class c on c.oid = t.tgrelid
        join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'app' and not t.tgisinternal
         and p.proname <> 'warehouse_no_cycle'
         and (p.prosrc ~* 'with recursive' or p.prosrc ~* 'perform app\.[a-z_]*tree')`;
    expect(recursive).toEqual([]);

    // And the read path that needs the tree is a single recursive CTE, planned once by Postgres.
    const rows = await withTenant(
      rw,
      ctx,
      (tx) => tx<{ id: string; depth: number }[]>`
      with recursive tree as (
        select id, parent_id, 0 as depth from app.account where parent_id is null
        union all
        select a.id, a.parent_id, tree.depth + 1 from app.account a join tree on a.parent_id = tree.id)
      select id, depth from tree order by depth, id`,
    );
    expect(Array.isArray(rows)).toBe(true);
  },
);

sliceRegression(
  "LEGACY-071",
  "Recursive tree check per row inside triggers",
  "1A",
  "the chart of accounts is read as ONE recursive CTE, and no trigger on account is recursive",
  async ({ db, expect }) => {
    const triggers = await db.admin<{ tgname: string }[]>`
      select tgname from pg_trigger where tgrelid = 'app.account'::regclass and not tgisinternal`;
    // Audit only; no tree check.
    expect(triggers.map((trigger) => trigger.tgname).toSorted()).toEqual(["audit_row"]);
    // `explain` names its column "QUERY PLAN", so read it positionally rather than by an invented key.
    const plan = await db.admin<Record<string, string>[]>`
      explain (format text) with recursive node as (
        select a.id, a.parent_id, 0 as depth from app.account a where a.parent_id is null
        union all
        select a.id, a.parent_id, n.depth + 1 from app.account a join node n on a.parent_id = n.id where n.depth < 32)
      select count(*) from node`;
    expect(plan.map((row) => Object.values(row)[0]!).join(" ")).toMatch(/Recursive Union|CTE Scan/);
  },
);

sliceRegression(
  "LEGACY-071",
  "Tree-integrity checks run a recursive procedure per row inside triggers",
  "3A",
  "the warehouse tree's cycle check is one CTE in one function, and app.warehouse is its only caller",
  async ({ db, expect }) => {
    const [fn] = await db.admin<{ src: string }[]>`
      select prosrc as src from pg_proc where proname = 'warehouse_no_cycle'
        and pronamespace = 'app'::regnamespace`;
    expect(fn!.src).toMatch(/with recursive/i);
    // The old system called a recursive PROCEDURE per row. Assert this one calls no procedure at all.
    expect(fn!.src).not.toMatch(/\bcall\b/i);
    const triggers = await db.admin<{ tbl: string }[]>`
      select c.relname as tbl from pg_trigger t join pg_class c on c.oid = t.tgrelid
        join pg_proc p on p.oid = t.tgfoid
       where not t.tgisinternal and p.proname = 'warehouse_no_cycle' order by 1`;
    expect(triggers.map((t) => t.tbl)).toEqual(["warehouse"]);
  },
);
