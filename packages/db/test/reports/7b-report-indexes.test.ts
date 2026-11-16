import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import { rebuildStockValuation } from "../../src/costing/valuation";
import { rebuildItemProfitability } from "../../src/projections/item-profitability";
import { lintSchema } from "../../src/lint-schema";
import { datasetFor, isDatasetId } from "../../src/reports/datasets";
import { datasetWhere, localTimezoneFor } from "../../src/reports/query";
import { startDb, withTenant, type Db } from "../harness";
// §4.17.1's 7B harness, reachable from packages/db/test/** through 3B's amendment A21(c).
import {
  CATALOGUE_7B,
  readEnvelope,
  reportFixture,
  type ReportFixture,
} from "../../../../tests/invariants/support/reports";
import { CATALOGUE_7C, readEnvelope7C } from "../../../../tests/invariants/support/reports-7c";

/**
 * 7B Task 10 — SAH-070's EXPLAIN gate: every report filter column of the twenty-two definitions is served by
 * an index (contracts round 14, amendments A7 and A17). 7C judges its own definitions here too (round 15, A17):
 * its filter pairs join the map, and the two closed lists below say why a pair is not judged by seekability.
 * Nothing is recorded unserved: the seven pairs 7C first listed so have their indexes in 0077 (round 15, A17 as
 * executed), and a new selective filter with no seekable index fails the seekability case.
 *
 * "Served" means SEEKABLE, and the gate asks two authorities:
 *
 * 1. **The catalogue (determinative).** A valid, non-partial btree index on the column's table has the column
 *    as a key, and every key column BEFORE it is bound by equality whenever the report runs: the scope column
 *    (`company_id`, or `tenant_id` for the tenant-scoped audit log) plus any `with` column every definition
 *    using the pair requires by `eq`. Key order is a property of the index, not of the data, which is why this
 *    half decides. "The column is in some index" is not enough — `inventory_movement_chrono_idx (company_id,
 *    item_id, warehouse_id, effective_date, …)` contains `effective_date` and still reads every item's entries
 *    for a company-wide date range, precisely SAH-070's full scan wearing an index's name. A PARTIAL index is
 *    not counted: a ReportDefinition filter cannot state "is null", so a report's WHERE never implies
 *    `archived_at is null` or `invalidated_at is null` and the planner cannot use one.
 * 2. **The planner (corroborating).** With `enable_seqscan = off`, a probe binding an ABSENT value of the
 *    column's own type plans no `Seq Scan` on the table — Postgres still emits one, priced at disable_cost,
 *    when no index applies at all (e.g. a parameter type that defeats every index). Why not "the planner's
 *    chosen index is the seekable one": on a fixture where a projection holds one row, every index of the
 *    table costs the same and the choice between them is a tie-break, not a judgement — a gate built on it
 *    passed or failed with the fixture's shape (`item_profitability`'s one row picked its period index for an
 *    item probe while the primary key seeks on `item_id`).
 *
 * The map is written out rather than derived because the field → column mapping is 7A's registry's (a
 * `document_type_code` filter is `dt.code`, reached through `document.document_type_id`; `branch_id` on
 * `ledger_entry` is the DOCUMENT's). Its keys are `<dataset id>.<DatasetColumn.field>`, snake_case (A3), and
 * the coverage case asserts the key set equals the definitions' filter pairs in BOTH directions, so a
 * stale entry cannot make the gate green about nothing.
 */
interface Target {
  table: string;
  column: string;
  scope: "company" | "tenant" | "none";
  /** Columns of `table` every definition filtering on this pair binds by a REQUIRED `eq` (checked below). */
  with?: readonly string[];
}

const COLUMN_OF: Readonly<Record<string, Target>> = {
  "ledger_entry.effective_date": {
    table: "ledger_entry",
    column: "effective_date",
    scope: "company",
  },
  "ledger_entry.account_id": { table: "ledger_entry", column: "account_id", scope: "company" },
  "ledger_entry.document_type_code": {
    table: "document",
    column: "document_type_id",
    scope: "company",
  },
  // The DOCUMENT join's branch (A3: `d.branch_id`), never `ledger_entry.company_id`, which every scope
  // predicate already supplies and which would report the branch cut "served" while nothing indexed it.
  "ledger_entry.branch_id": { table: "document", column: "branch_id", scope: "company" },
  "account_balance.fiscal_period_id": {
    table: "account_balance",
    column: "fiscal_period_id",
    scope: "company",
  },
  // Only `accounting.trial_balance` filters by currency, and its `fiscalPeriodId` is required.
  "account_balance.currency": {
    table: "account_balance",
    column: "currency",
    scope: "company",
    with: ["fiscal_period_id"],
  },
  "account_balance.account_type": { table: "account", column: "type", scope: "company" },
  "document.effective_date": { table: "document", column: "effective_date", scope: "company" },
  "document.document_type_code": {
    table: "document",
    column: "document_type_id",
    scope: "company",
  },
  "document.status": { table: "document", column: "status", scope: "company" },
  "document.branch_id": { table: "document", column: "branch_id", scope: "company" },
  "document_event.occurred_at": {
    table: "document_event",
    column: "occurred_at",
    scope: "company",
  },
  "document_event.document_type_code": {
    table: "document",
    column: "document_type_id",
    scope: "company",
  },
  "document_event.event_kind": { table: "document_event", column: "event_kind", scope: "company" },
  "document_event.to_status": { table: "document_event", column: "to_status", scope: "company" },
  "audit_log.occurred_at": { table: "audit_log", column: "occurred_at", scope: "tenant" },
  "audit_log.table_name": { table: "audit_log", column: "table_name", scope: "tenant" },
  "audit_log.action": { table: "audit_log", column: "action", scope: "tenant" },
  "audit_log.actor_id": { table: "audit_log", column: "actor_id", scope: "tenant" },
  "inventory_movement.effective_date": {
    table: "inventory_movement",
    column: "effective_date",
    scope: "company",
  },
  "inventory_movement.item_id": {
    table: "inventory_movement",
    column: "item_id",
    scope: "company",
  },
  "inventory_movement.warehouse_id": {
    table: "inventory_movement",
    column: "warehouse_id",
    scope: "company",
  },
  "inventory_movement.document_type_code": {
    table: "document",
    column: "document_type_id",
    scope: "company",
  },
  "cost_layer.item_id": { table: "cost_layer", column: "item_id", scope: "company" },
  // `inventory.stock_ageing` is the only reader, and its `itemId` is required.
  "cost_layer.warehouse_id": {
    table: "cost_layer",
    column: "warehouse_id",
    scope: "company",
    with: ["item_id"],
  },
  "stock_on_hand.item_id": { table: "stock_on_hand", column: "item_id", scope: "company" },
  "stock_on_hand.warehouse_id": {
    table: "stock_on_hand",
    column: "warehouse_id",
    scope: "company",
  },
  "stock_on_hand.warehouse_kind": { table: "warehouse", column: "kind", scope: "company" },
  "stock_on_hand.quantity": { table: "stock_on_hand", column: "quantity", scope: "company" },
  "stock_valuation.as_of": { table: "stock_valuation", column: "as_of", scope: "company" },
  "stock_valuation.item_id": { table: "stock_valuation", column: "item_id", scope: "company" },
  // `inventory.valuation` is the only reader, and its `asOf` is required.
  "stock_valuation.warehouse_id": {
    table: "stock_valuation",
    column: "warehouse_id",
    scope: "company",
    with: ["as_of"],
  },
  "item_profitability.fiscal_period_id": {
    table: "item_profitability",
    column: "fiscal_period_id",
    scope: "company",
  },
  "item_profitability.item_id": {
    table: "item_profitability",
    column: "item_id",
    scope: "company",
  },
  "lot.expires_on": { table: "lot", column: "expires_on", scope: "company" },
  "lot.item_id": { table: "lot", column: "item_id", scope: "company" },
  // `app.price_list_line` carries no company column; the dataset scopes through `price_list.company_id`.
  "price_list_line.price_list_id": {
    table: "price_list_line",
    column: "price_list_id",
    scope: "none",
  },
  "price_list_line.item_id": { table: "price_list_line", column: "item_id", scope: "none" },
  "promotion.kind": { table: "promotion", column: "kind", scope: "company" },
  // ── 7C Task 3 — the AR/AP definitions ──
  "party_ageing.as_of": { table: "party_ageing", column: "as_of", scope: "company" },
  "party_ageing.party_kind": { table: "party", column: "kind", scope: "company" },
  "party_ageing.currency": {
    table: "party_ageing",
    column: "currency",
    scope: "company",
    with: ["as_of"],
  },
  "document.party_id": { table: "document", column: "party_id", scope: "company" },
  // The SETTLED document's date and the SETTLEMENT document's type (the dataset's `dd` and `sd` joins).
  "allocation.settled_effective_date": {
    table: "document",
    column: "effective_date",
    scope: "company",
  },
  "allocation.party_id": { table: "allocation", column: "party_id", scope: "company" },
  "allocation.settlement_type_code": {
    table: "document",
    column: "document_type_id",
    scope: "company",
  },
  "bank_statement_line.is_matched": {
    table: "bank_statement_line",
    column: "amount",
    scope: "company",
  },
  "bank_statement_line.bank_account_id": {
    table: "bank_statement",
    column: "bank_account_id",
    scope: "company",
  },
  "bank_statement_line.value_date": {
    table: "bank_statement_line",
    column: "value_date",
    scope: "company",
  },
  // ── 7C Task 4 — the POS and cross-module definitions ──
  "shift.shift_id": { table: "shift", column: "id", scope: "company" },
  "shift.branch_id": { table: "shift", column: "branch_id", scope: "company" },
  // `opened_on` is `(opened_at at time zone company.timezone)::date` (A1); the column under it is opened_at, and a
  // range on it compiles to opened_at bounds (`localDateOf`) — the companion case below proves the planner seeks.
  "shift.opened_on": { table: "shift", column: "opened_at", scope: "company" },
  "shift.cashier_principal_id": {
    table: "shift",
    column: "opened_principal_id",
    scope: "company",
  },
  "needs_attention.is_open": {
    table: "needs_attention",
    column: "resolved_at",
    scope: "company",
  },
  "needs_attention.branch_id": {
    table: "needs_attention",
    column: "branch_id",
    scope: "company",
  },
  "needs_attention.error_code": {
    table: "needs_attention",
    column: "error_code",
    scope: "company",
  },
  "needs_attention.created_on": {
    table: "needs_attention",
    column: "created_at",
    scope: "company",
  },
  // A statement's branch is the posting DOCUMENT's (`statementRows`' ledger_entry branch, A5), exactly as
  // 7B's `ledger_entry.branch_id` above.
  "account_balance.branch_id": { table: "document", column: "branch_id", scope: "company" },
  "tax_transaction.fiscal_period_id": {
    table: "tax_transaction",
    column: "fiscal_period_id",
    scope: "company",
  },
  "tax_transaction.tax_code_kind": { table: "tax_code", column: "kind", scope: "company" },
  "tax_transaction.regime_code": { table: "tax_regime", column: "code", scope: "company" },
};

/**
 * Low-selectivity enumerations, judged NOT by seekability, each with its reason. SAH-070's own table names
 * this class ("`ItmSite` ~1 distinct value", "`ItmLevel` very low selectivity") as columns an index does not
 * help: an index on a handful of values reads a large fraction of the table either way. Each is an
 * OPTIONAL narrowing over a report whose rows are already bounded — by a required, seekable filter, or (for
 * `stock_on_hand.warehouse_kind`) by the company-leading primary key of a projection the report reads
 * whole. The list is closed (A17): a new entry is a contracts amendment, and the gate asserts below that no
 * selective pair hides here.
 */
const RESIDUAL: Readonly<Record<string, string>> = {
  "document.status": "app.document_status — six values; inside the register's required date range",
  "document_event.event_kind":
    "a handful of transition kinds; inside the required occurred_at window",
  "document_event.to_status": "app.document_status again; inside the required occurred_at window",
  "audit_log.action": "insert / update / delete; inside the required occurred_at window",
  "account_balance.account_type":
    "five account types on the joined chart; inside the required fiscal period",
  "stock_on_hand.warehouse_kind": "stock / in_transit and the like on the joined warehouse",
  "promotion.kind": "the promotion kinds of §4.6.1 over a master-data table",
  "stock_on_hand.quantity":
    "`quantity <> 0` — a NOT-EQUAL no btree seeks on; it drops the zero rows of a projection read by company",
  // ── 7C (contracts round 15, A17) ──
  "party_ageing.party_kind":
    "app.party.kind — five values (2A); inside the required asOf snapshot party_ageing_as_of_idx seeks",
  "party_ageing.currency":
    "a company's handful of trading currencies; inside the required asOf snapshot party_ageing_as_of_idx seeks",
  "needs_attention.error_code":
    "the handful of ERR_* codes a sync apply refuses with, over the needs-attention exception log",
  "tax_transaction.tax_code_kind":
    "app.tax_code.kind — output / input on the joined tax code; inside the required fiscal period",
};

/**
 * COMPUTED fields (7C, contracts round 15, A17): the dataset field is an EXPRESSION, not a column, so there is
 * no column for a btree to hold and the seekability question has no subject. Each is two-valued or a
 * timezone-shifted date, and each narrows rows another filter or the company scope already bounds. Closed like
 * RESIDUAL; the gate asserts each is a real filter pair.
 */
const COMPUTED: Readonly<Record<string, string>> = {
  "bank_statement_line.is_matched":
    "`coalesce(Σ live bank_match.amount, 0) = amount` — two-valued, computed per line through the lateral that " +
    "seeks bank_match by statement_line_id; the statement lines are bounded by the company and value_date",
  "needs_attention.is_open":
    "`resolved_at is null` — two-valued; the open set is exactly what the partial needs_attention_open_idx " +
    "holds, which the gate does not credit because a definition filter cannot state `is null` directly",
};

/** The indexes migration 0077 adds, with their exact key lists — 7B's fourteen and 7C's seven (round 15, A17 as
 *  executed: the seven filters 7C first recorded as UNSERVED, each now seekable like any other pair). */
const NEW_INDEXES: Readonly<Record<string, string>> = {
  allocation_company_party_idx: "(company_id, party_id)",
  audit_log_tenant_actor_time_idx: "(tenant_id, actor_id, occurred_at)",
  audit_log_tenant_table_time_idx: "(tenant_id, table_name, occurred_at)",
  audit_log_tenant_time_idx: "(tenant_id, occurred_at)",
  cost_layer_company_item_warehouse_idx: "(company_id, item_id, warehouse_id)",
  document_company_branch_date_idx: "(company_id, branch_id, effective_date)",
  document_company_date_idx: "(company_id, effective_date)",
  document_company_party_date_idx: "(company_id, party_id, effective_date)",
  document_company_type_date_idx: "(company_id, document_type_id, effective_date)",
  document_event_company_time_idx: "(company_id, occurred_at)",
  inventory_movement_company_date_idx: "(company_id, effective_date, posting_seq)",
  inventory_movement_company_warehouse_date_idx: "(company_id, warehouse_id, effective_date)",
  lot_company_expires_idx: "(company_id, expires_on)",
  needs_attention_company_branch_created_idx: "(company_id, branch_id, created_at)",
  needs_attention_company_created_idx: "(company_id, created_at)",
  price_list_line_item_any_idx: "(item_id)",
  shift_company_cashier_opened_idx: "(company_id, opened_principal_id, opened_at)",
  shift_company_opened_idx: "(company_id, opened_at)",
  stock_on_hand_company_warehouse_idx: "(company_id, warehouse_id)",
  stock_valuation_company_as_of_idx: "(company_id, as_of, warehouse_id)",
  tax_transaction_company_period_idx: "(company_id, fiscal_period_id)",
};

/** A value of each probed column type that no fixture row holds (see the seekability case). */
const ABSENT: Readonly<Record<string, string>> = {
  uuid: "00000000-0000-7000-8000-000000000000",
  date: "1900-01-01",
  "timestamp with time zone": "1900-01-01T00:00:00Z",
  text: "sah-070-probe",
  "character(3)": "ZZZ",
};

/** Every shipped definition the gate judges — 7B's twenty-two and 7C's, each read through its own slice's
 *  reader (the two seed directories are disjoint). */
function definitionOf(code: string) {
  return (CATALOGUE_7B as readonly string[]).includes(code)
    ? readEnvelope(code).definition
    : readEnvelope7C(code).definition;
}
const GATED_CODES: readonly string[] = [...CATALOGUE_7B, ...CATALOGUE_7C];

/** Every (dataset.field) a shipped definition filters on, with the definitions that do. */
function filterPairs(): Map<string, { code: string; field: string }[]> {
  const pairs = new Map<string, { code: string; field: string }[]>();
  for (const code of GATED_CODES) {
    const d = definitionOf(code);
    for (const clause of d.dataset.filters) {
      const key = `${d.dataset.source}.${clause.field}`;
      pairs.set(key, [...(pairs.get(key) ?? []), { code, field: clause.field }]);
    }
  }
  return pairs;
}

interface PlanNode {
  "Node Type": string;
  "Index Name"?: string;
  "Index Cond"?: string;
  "Relation Name"?: string;
  Plans?: PlanNode[];
}

/** Every node of a plan tree, depth first. */
function nodes(node: PlanNode): PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap(nodes)];
}

describe("SAH-070 — every report filter column is served by an index (7B, migration 0077)", () => {
  let db: Db;
  let f: ReportFixture;

  beforeAll(async () => {
    db = await startDb();
    f = await reportFixture(db, "Alpha", { inventory: true, sales: true, catalogue: true });
    // Both projections are asynchronous; their rebuilds are 3B's and 4B's own functions (hazard 20), run so
    // `stock_valuation` and `item_profitability` carry real statistics for the probe.
    await withTenant(db.rw, f.s.tenant, f.s.system, async (tx) => {
      await rebuildStockValuation(tx, { companyId: f.s.company, asOf: "2026-01-31" });
      await rebuildItemProfitability(tx, { companyId: f.s.company });
    });
    // Fresh statistics, so the planner costs each candidate index by its real selectivity. A never-analysed
    // table is planned on default estimates, under which a company-leading index with the target in `Filter`
    // can tie with the index that seeks on it — and the gate would be judging the defaults, not the indexes.
    const tables = [...new Set(Object.values(COLUMN_OF).map((t) => t.table))];
    for (const table of tables) await db.admin`analyze app.${db.admin(table)}`;
  }, 300_000);
  afterAll(async () => {
    await db?.stop();
  });

  it("the column map is exactly the definitions' filter pairs — a new filter must be considered here", () => {
    const pairs = [...filterPairs().keys()].toSorted();
    expect(Object.keys(COLUMN_OF).toSorted()).toEqual(pairs);
    for (const key of [...Object.keys(RESIDUAL), ...Object.keys(COMPUTED)])
      expect(pairs, key).toContain(key);
  });

  it("every `with` column is one every definition using the pair binds by a required eq filter", () => {
    const pairs = filterPairs();
    for (const [key, target] of Object.entries(COLUMN_OF)) {
      for (const column of target.with ?? []) {
        for (const { code } of pairs.get(key) ?? []) {
          const d = definitionOf(code);
          const bound = d.dataset.filters.some(
            (c) =>
              c.field === column &&
              c.op === "eq" &&
              d.parameters.some((p) => p.name === c.param && p.required),
          );
          expect(bound, `${code} filters ${key} without a required ${column} = …`).toBe(true);
        }
      }
    }
  });

  it("the indexes of migration 0077 exist with their exact names and key lists", async () => {
    const rows = await db.admin<{ indexname: string; indexdef: string }[]>`
      select indexname, indexdef from pg_indexes
       where schemaname = 'app' and indexname = any(${Object.keys(NEW_INDEXES)}) order by indexname`;
    expect(rows.map((r) => r.indexname)).toEqual(Object.keys(NEW_INDEXES).toSorted());
    for (const r of rows) {
      expect(r.indexdef, r.indexname).toContain(`USING btree ${NEW_INDEXES[r.indexname]!}`);
      expect(r.indexdef, `${r.indexname} must not be partial`).not.toContain(" WHERE ");
    }
  });

  it("every selective filter column is SEEKABLE through a non-partial index, and the planner uses an index", async () => {
    const indexes = await db.admin<{ name: string; table: string; cols: string[] }[]>`
      select i.relname as name, t.relname as "table",
             (select array_agg(a.attname::text order by k.ord)
                from unnest(ix.indkey) with ordinality as k(attnum, ord)
                join pg_attribute a on a.attrelid = ix.indrelid and a.attnum = k.attnum) as cols
        from pg_index ix
        join pg_class i on i.oid = ix.indexrelid
        join pg_class t on t.oid = ix.indrelid
        join pg_am am on am.oid = i.relam
       where t.relnamespace = 'app'::regnamespace and am.amname = 'btree'
         and ix.indisvalid and ix.indpred is null`;
    const columnType = new Map(
      (
        await db.admin<{ key: string; type: string }[]>`
          select c.relname || '.' || a.attname as key, format_type(a.atttypid, a.atttypmod) as type
            from pg_attribute a join pg_class c on c.oid = a.attrelid
           where c.relnamespace = 'app'::regnamespace and c.relkind = 'r' and a.attnum > 0`
      ).map((r) => [r.key, r.type] as const),
    );

    const failures: string[] = [];
    await withTenant(db.rw, f.s.tenant, f.reader, async (tx: Sql) => {
      await tx`set local enable_seqscan = off`;
      for (const [field, target] of Object.entries(COLUMN_OF)) {
        if (field in RESIDUAL || field in COMPUTED) continue;
        const scopeColumn =
          target.scope === "company"
            ? "company_id"
            : target.scope === "tenant"
              ? "tenant_id"
              : null;
        const bound = [...(scopeColumn === null ? [] : [scopeColumn]), ...(target.with ?? [])];

        // 1. The catalogue.
        const seekable = indexes.filter((ix) => {
          if (ix.table !== target.table) return false;
          const at = ix.cols.indexOf(target.column);
          return at >= 0 && ix.cols.slice(0, at).every((c) => bound.includes(c));
        });
        if (seekable.length === 0) {
          const holding = indexes
            .filter((ix) => ix.table === target.table && ix.cols.includes(target.column))
            .map((ix) => `${ix.name} (${ix.cols.join(", ")})`);
          failures.push(
            `${field} → app.${target.table}(${target.column}): no non-partial index seeks on it with [${bound.join(", ")}] bound; indexes holding it: [${holding.join("; ")}]`,
          );
          continue;
        }

        // 2. The planner. The probe binds an ABSENT value, bound as an untyped string so the server resolves
        // it to the column's own type: a JS `Date` would bind as `timestamptz` and turn a `date` equality into
        // a cast no index serves. No value vocabulary of another slice is guessed — every enumerated column is
        // in RESIDUAL.
        const scopeValue = target.scope === "company" ? f.s.company : f.s.tenant;
        let predicate = scopeColumn === null ? tx`true` : tx`${tx(scopeColumn)} = ${scopeValue}`;
        let typed = true;
        for (const column of [...(target.with ?? []), target.column]) {
          const type = columnType.get(`${target.table}.${column}`);
          const absent = type === undefined ? undefined : ABSENT[type];
          if (absent === undefined) {
            failures.push(
              `${field} → app.${target.table}(${column}) is ${String(type)}, which ABSENT lacks`,
            );
            typed = false;
            break;
          }
          predicate = tx`${predicate} and ${tx(column)} = ${absent}`;
        }
        if (!typed) continue;
        const [row] = await tx<{ "QUERY PLAN": { Plan: PlanNode }[] }[]>`
          explain (format json) select 1 from app.${tx(target.table)} where ${predicate}`;
        const plan = nodes(row!["QUERY PLAN"][0]!.Plan);
        const seq = plan.find(
          (n) => n["Node Type"] === "Seq Scan" && n["Relation Name"] === target.table,
        );
        if (seq !== undefined) {
          failures.push(
            `${field} → app.${target.table}(${target.column}) plans a Seq Scan with enable_seqscan off: no index applies to the probe`,
          );
        }
      }
    });
    expect(
      failures,
      "SAH-070: a report filter no index can seek on — the index is missing (contracts A7/A17)",
    ).toEqual([]);
  });

  // A pair whose dataset field is a DATE over a timestamptz column is the company-timezone companion
  // (`(x at time zone tz)::date`): the catalogue above credits the instant's index, which is honest only if the
  // compiled predicate is bounds on the instant. So every such pair must declare `localDateOf`, and the planner,
  // given the compiled WHERE over the bare table, must put the instant in an Index Cond.
  it("a timezone date companion compiles to bounds on its instant, and the planner seeks them", async () => {
    const ALIAS: Readonly<Record<string, string>> = { shift: "s", needs_attention: "na" };
    const types = new Map(
      (
        await db.admin<{ key: string; type: string }[]>`
          select c.relname || '.' || a.attname as key, format_type(a.atttypid, a.atttypmod) as type
            from pg_attribute a join pg_class c on c.oid = a.attrelid
           where c.relnamespace = 'app'::regnamespace and c.relkind = 'r' and a.attnum > 0`
      ).map((r) => [r.key, r.type] as const),
    );
    const companions = Object.entries(COLUMN_OF).filter(([key, t]) => {
      const [source, field] = key.split(".") as [string, string];
      if (!isDatasetId(source)) return false;
      const column = datasetFor(source).columns.find((c) => c.field === field);
      return (
        column?.kind === "date" &&
        types.get(`${t.table}.${t.column}`) === "timestamp with time zone"
      );
    });
    expect(companions.map(([key]) => key).toSorted()).toEqual([
      "needs_attention.created_on",
      "shift.opened_on",
    ]);
    await withTenant(db.rw, f.s.tenant, f.reader, async (tx: Sql) => {
      // The probe orders by the instant with sorting off, so only an index ordered on (company_id, instant) can
      // serve it: on a fixture holding no such rows every index costs the same, and without this the planner's
      // pick is a tie-break (the unique client_ref key, the instant left in `Filter`) that says nothing about
      // whether the predicate is sargable. With it, a sargable bound lands in that index's Index Cond and a
      // non-sargable one stays in Filter — the distinction this case exists to draw.
      await tx`set local enable_seqscan = off`;
      await tx`set local enable_sort = off`;
      for (const [key, target] of companions) {
        const [source, field] = key.split(".") as [string, string];
        if (!isDatasetId(source)) continue;
        const columns = datasetFor(source).columns;
        expect(columns.find((c) => c.field === field)?.localDateOf, key).toBeDefined();
        const alias = ALIAS[target.table];
        expect(alias, `${key}: the dataset's alias for app.${target.table}`).toBeDefined();
        const filters = [
          { field, op: "gte", value: "2026-03-01" },
          { field, op: "lte", value: "2026-03-31" },
        ] as const;
        // The zone exactly as a run reads it: once, on the run's own transaction, then bound as a value.
        const local = await localTimezoneFor(tx, columns, filters, f.s.company);
        expect(local, `${key}: the run's company timezone`).toBeDefined();
        const where = datasetWhere(tx, columns, filters, source, local);
        const [row] = await tx<{ "QUERY PLAN": { Plan: PlanNode }[] }[]>`
          explain (format json)
          select 1 from app.${tx(target.table)} ${tx(alias!)}
           where ${tx(alias!)}.company_id = ${f.s.company}::uuid ${where}
           order by ${tx(alias!)}.${tx(target.column)}`;
        // A Bitmap Index Scan names its index, not its relation.
        const plan = nodes(row!["QUERY PLAN"][0]!.Plan).filter(
          (n) =>
            n["Relation Name"] === target.table ||
            (n["Index Name"] ?? "").startsWith(`${target.table}_`),
        );
        expect(
          plan.map((n) => n["Node Type"]),
          `${key} must not Seq Scan`,
        ).not.toContain("Seq Scan");
        expect(
          plan.some((n) => (n["Index Cond"] ?? "").includes(target.column)),
          `${key}: no Index Cond on ${target.column} — ${JSON.stringify(plan)}`,
        ).toBe(true);
      }
    });
  });

  it("the schema linter still reports zero violations", async () => {
    expect(await lintSchema(db.admin)).toEqual([]);
  });
});
