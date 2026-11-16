// packages/db/src/sync/catalogue.ts
import type { Sql } from "postgres";

/** The eight streams of §4.10.1, in the SQL below and in `app.catalogue_tombstone.stream`'s check. */
export type CatalogueStream =
  | "item"
  | "price_list"
  | "price_list_line"
  | "promotion"
  | "customer"
  | "tax_code"
  | "cashier"
  | "branch_pos_policy";

export interface CatalogueChange {
  stream: CatalogueStream;
  op: "upsert" | "delete";
  id: string;
  revision: bigint;
  row: Record<string, unknown> | null;
}
export interface ReadCatalogueInput {
  companyId: string;
  branchId: string;
  since: bigint;
  limit: number;
}
export interface CatalogueSlice {
  changes: CatalogueChange[];
  nextCursor: bigint;
  hasMore: boolean;
}

interface RawChange {
  stream: CatalogueStream;
  op: "upsert" | "delete";
  id: string;
  revision: string;
  row: Record<string, unknown> | null;
}

/**
 * One page of the branch's catalogue, strictly after `since`, ordered by revision.
 *
 * **Why one UNION ALL and not one query per stream.** The cursor is a single scalar across every stream
 * (§4.10.2), so the page boundary has to be a single revision — paging each stream separately would leave the
 * till holding eight cursors and one wire cursor that means none of them. `CATALOGUE_STREAMS` exists for the
 * till's *apply* order; the server's order is the revision.
 *
 * **Why an archived row appears only as a tombstone.** Every `where` on a live row excludes `archived_at is
 * not null`, and the tombstone carries the row's own final revision (migration 0059), so the two can never
 * both land in one window and a till never applies an upsert after the delete of the same row.
 *
 * The staff and branch policy streams share this same query and page boundary. Their owning SQL
 * functions provide the projection, so this reader does not duplicate their column lists.
 */
export async function readCatalogue(tx: Sql, input: ReadCatalogueInput): Promise<CatalogueSlice> {
  const rows = await tx<RawChange[]>`
    with live as (
      select 'item'::text as stream, i.id, i.revision, to_jsonb(i) - 'tenant_id' || jsonb_build_object('revision', i.revision::text) as row
        from app.item i
       where i.company_id = ${input.companyId} and i.revision > ${input.since.toString()} and i.archived_at is null
      union all
      -- Form B in a query: a NULL branch means EVERY branch, so a company-wide price list or promotion must
      -- be delivered. Writing branch_id = $branch here would silently starve every till of head-office
      -- pricing, and nothing would fail — the till would just quietly sell at the wrong price.
      select 'price_list', p.id, p.revision, to_jsonb(p) - 'tenant_id' || jsonb_build_object('revision', p.revision::text)
        from app.price_list p
       where p.company_id = ${input.companyId} and p.revision > ${input.since.toString()} and p.archived_at is null
         and (p.branch_id is null or p.branch_id = ${input.branchId})
      union all
      -- BOTH archived_at predicates. price_list_line has its own (3A added it deliberately, phase-3a:2399,
      -- because §3.5.4 pins the app_rw DELETE list and replacePriceListLines therefore archives a line it
      -- cannot delete). Without l.archived_at is null an archived line would keep arriving as an upsert
      -- FOREVER, one revision after its own tombstone, and the till would resurrect a price nobody set.
      select 'price_list_line', l.id, l.revision, to_jsonb(l) - 'tenant_id' || jsonb_build_object('revision', l.revision::text, 'unit_price', l.unit_price::text, 'min_quantity', l.min_quantity::text)
        from app.price_list_line l
        join app.price_list p on p.id = l.price_list_id
       where p.company_id = ${input.companyId} and l.revision > ${input.since.toString()}
         and l.archived_at is null and p.archived_at is null
         and (p.branch_id is null or p.branch_id = ${input.branchId})
      union all
      -- NO archived_at predicate here, and this is a fact about 3A's schema, not an omission: app.promotion
      -- has no such column (phase-3a:2419-2444 — "a promotion is retired by setting ends_at, which is what a
      -- date-windowed offer means"), so r.archived_at is null would raise 42703 on EVERY call and no page
      -- would ever be returned. There is no ends_at > now() filter either: an edit that shortens the window
      -- bumps the revision, so the shortened row travels as an upsert and the till's own window check retires
      -- it. Filtering here would turn that edit into a silent absence — the till would keep the OLD window,
      -- which is exactly the failure spec:1300 and acceptance test 20 forbid.
      select 'promotion', r.id, r.revision, to_jsonb(r) - 'tenant_id' || jsonb_build_object('revision', r.revision::text, 'definition', (select coalesce(jsonb_object_agg(e.key, case when jsonb_typeof(e.value) = 'number' then to_jsonb(e.value::text) else e.value end), '{}'::jsonb) from jsonb_each(r.definition) e))
        from app.promotion r
       where r.company_id = ${input.companyId} and r.revision > ${input.since.toString()}
         and (r.branch_id is null or r.branch_id = ${input.branchId})
      union all
      -- The till mirrors CUSTOMERS (spec:1328's catalogue_customer). A vendor carries a revision because the
      -- column is NOT NULL, and is simply never selected.
      select 'customer', c.id, c.revision, to_jsonb(c) - 'tenant_id' - 'tax_registration' || jsonb_build_object('revision', c.revision::text, 'credit_limit', c.credit_limit::text)
        from app.party c
       where c.company_id = ${input.companyId} and c.revision > ${input.since.toString()} and c.archived_at is null
         and c.kind = 'customer'
      union all
      select 'tax_code', t.id, t.revision, to_jsonb(t) - 'tenant_id' || jsonb_build_object('revision', t.revision::text, 'rate', t.rate::text)
        from app.tax_code t
       where t.company_id = ${input.companyId} and t.revision > ${input.since.toString()} and t.archived_at is null
      union all
      select 'cashier', k.id, k.revision, k.row
        from app.pos_cashier_sync(${input.companyId}, ${input.branchId}, ${input.since.toString()}) k
      union all
      select 'branch_pos_policy', b.id, b.revision, b.row
        from app.branch_pos_policy_sync(${input.companyId}, ${input.branchId}, ${input.since.toString()}) b
    ),
    dead as (
      select t.stream, t.row_id as id, t.revision, null::jsonb as row
        from app.catalogue_tombstone t
       where t.company_id = ${input.companyId} and t.revision > ${input.since.toString()}
         and (t.branch_id is null or t.branch_id = ${input.branchId})
    )
    -- ⚠️ The ORDER BY is INSIDE the subquery, over the BIGINT, and the ::text casts happen outside it.
    -- In a set operation PostgreSQL resolves ORDER BY against the OUTPUT column list only, so an
    -- order by revision written beside revision::text as revision sorts the TEXT: "10" < "2" < "9".
    -- With limit 4 over revisions 1..30 the first page would be 1, 10, 11, 12, nextCursor would be 12, and
    -- revisions 2..9 would never be delivered to any till — silently, for ever. That is the exact failure
    -- acceptance test 20 exists to catch, and the ordering is the only thing standing between the two.
    -- order by p.revision on the outer select is QUALIFIED, so it binds the subquery's bigint column and
    -- not the text output column of the same name; it is there because a plain SELECT over an ordered
    -- subquery is not guaranteed to preserve that order.
    select p.stream, p.op, p.id::text as id, p.revision::text as revision, p.row
      from (
        select stream, 'upsert'::text as op, id, revision, row from live
        union all
        select stream, 'delete'::text as op, id, revision, row from dead
        order by revision
        limit ${input.limit + 1}
      ) p
     order by p.revision`;

  const hasMore = rows.length > input.limit;
  const page = hasMore ? rows.slice(0, input.limit) : rows;
  const changes = page.map((r) => ({
    stream: r.stream,
    op: r.op,
    id: r.id,
    revision: BigInt(r.revision),
    row: r.row,
  }));
  const nextCursor = changes.length === 0 ? input.since : changes.at(-1)!.revision;
  return { changes, nextCursor, hasMore };
}

export async function currentCatalogueRevision(tx: Sql, companyId: string): Promise<bigint> {
  const [row] = await tx<{ r: string }[]>`
    select coalesce(max(revision), 0)::text as r from (
      select max(revision) as revision from app.item where company_id = ${companyId}
      union all select max(revision) from app.price_list where company_id = ${companyId}
      -- price_list_line has no company_id of its own (3A) and reaches the company through its parent. It is
      -- in this union because a LINE edit is often the company's highest revision — a price change is the
      -- commonest catalogue write there is — and a catalogueCursor that ignored it would tell every till it
      -- was up to date while its prices were stale.
      union all select max(l.revision) from app.price_list_line l
                  join app.price_list p on p.id = l.price_list_id where p.company_id = ${companyId}
      union all select max(revision) from app.promotion where company_id = ${companyId}
      union all select max(revision) from app.party where company_id = ${companyId}
      union all select max(revision) from app.tax_code where company_id = ${companyId}
      union all select max(revision) from app.catalogue_tombstone where company_id = ${companyId}
      union all select max(revision) from app.pos_cashier where company_id = ${companyId}
      union all select max(revision) from app.branch_pos_policy where company_id = ${companyId}
    ) m`;
  return BigInt(row!.r);
}
