import type { Sql } from "postgres";

export interface Violation {
  table: string;
  rule: string;
  detail: string;
}
const globalTables = new Set(["tenant", "principal", "permission"]);
export const noId = new Set([
  "pos_cashier", // 6C: keyed by the cashier's principal.
  "membership",
  "role_permission",
  "role_assignment",
  "role_assignment_branch",
  "ledger_entry_dimension",
  "document_series",
  "document_number_void",
  "idempotency_key",
  "audit_log",
  "permission",
  // 1A: natural key (company, account, period, currency) — contracts §3.5.3.
  "account_balance",
  // 3A: natural key (company_id, item_id, warehouse_id, lot_id) — contracts §3.5.3.
  "stock_on_hand",
  // 3B: natural key (company_id, item_id, warehouse_id, as_of) — contracts §3.5.3, §4.6.1.
  "stock_valuation",
  // 4B: natural key (company_id, party_id, currency, as_of, bucket) — contracts §3.5.3, §4.6.1.
  "party_ageing",
  // 4B: natural key (company_id, item_id, fiscal_period_id) — contracts §3.5.3, §4.6.1.
  "item_profitability",
  // 8A: keyed on employee_id (one row per employee, migration 0081) and a pure join (migration 0083) — §3.5.3.
  "employee_sensitive",
  "pay_component_scheme",
  // 8B: 1:1 extensions of document and document_line, keyed on document_id / document_line_id (0087) — §3.5.3.
  "payroll_run",
  "payroll_line",
  // 8C: natural key (company_id, employee_id, tax_year), the account_balance shape (0092) — §3.5.3.
  "employee_ytd",
]);
const noCreatedAt = new Set([...noId, "ledger_entry"]);
export const AUDIT_EXEMPT = new Set([
  "till_event",
  "pos_cashier",
  "tax_transaction",
  "ledger_entry",
  "ledger_entry_dimension",
  "inventory_movement",
  "document_event",
  "audit_log",
  "account_balance",
  "cost_layer",
  "cost_consumption",
  "employee_ytd",
  "idempotency_key",
  "permission",
  // 3A: derived projection, MERGEd from inventory_movement in the posting transaction — contracts §3.5.3.
  "stock_on_hand",
  // 3B: async projection rebuilt by inventory.projection.rebuild (spec:1204) — contracts §3.5.3.
  "stock_valuation",
  // 4B: async projection rebuilt by accounting.projection.rebuild from ledger_entry + allocation — §3.5.3.
  "party_ageing",
  // 4B: async projection rebuilt by accounting.projection.rebuild from ledger_entry + movements — §3.5.3.
  "item_profitability",
  // Code review 2 (migration 0115): the cost replay's per-movement booking state, derived from the movements
  // and the COST_ADJUSTMENT documents it posts, exactly as cost_layer and cost_consumption are.
  "cost_booking",
  // PR 12 review (migration 0060): the signed-request replay guard is per-request transport state, exactly as
  // idempotency_key is; an audited write on every till poll would grow app.audit_log without bound.
  "terminal_request_guard",
]);
export const IMMUTABLE = new Set([
  "till_event",
  "tax_transaction",
  "ledger_entry",
  "ledger_entry_dimension",
  "inventory_movement",
  "document_event",
  "audit_log",
]);
const allowedPermissivePolicies = new Set([
  "tenant_isolation",
  "tenant_self",
  "principal_in_tenant",
  "principal_update_in_tenant",
  "principal_insert",
]);

/** Tables whose permission gate is a named RESTRICTIVE policy. A listed table that exists without a RESTRICTIVE
 *  policy of its mapped name is a build failure — §3.5.2's `sensitive_gate` rule, widened to three tables by 8A
 *  amendment A9 because test 32 (spec:2450) demands the same direct-SQL proof for compensation rows as for
 *  identity ones. A table not yet created (0082, 0083) is simply absent from the loop below. */
const GATED_TABLES: ReadonlyMap<string, string> = new Map([
  ["employee_sensitive", "sensitive_gate"],
  ["compensation_line", "compensation_gate"],
  ["employee_statutory_profile", "compensation_gate"],
]);

/** Branch grants are read by the predicate itself; applying that predicate to them would recurse. */
export const BRANCH_ISOLATION_EXEMPT = new Set(["role_assignment_branch"]);
const BRANCH_ISOLATED_BY_WAREHOUSE = new Set([
  "inventory_movement",
  "stock_on_hand",
  "cost_layer",
  "cost_consumption",
  "stock_valuation",
]);

export async function lintSchema(sql: Sql): Promise<Violation[]> {
  const [tables, columns, policies, triggers, grants, fks] = await Promise.all([
    // 'p' = a partitioned table's parent. plan0A:2037 partitions ledger_entry by fiscal year once volume
    // warrants it; with relkind = 'r' the parent would vanish from every rule below and an unprotected
    // partitioned table would lint clean (contracts §3.5.2, rule relkind_partition).
    sql<
      { relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }[]
    >`select relname, relrowsecurity, relforcerowsecurity from pg_class where relnamespace = 'app'::regnamespace and relkind in ('r', 'p')`,
    sql<
      { table_name: string; column_name: string }[]
    >`select table_name, column_name from information_schema.columns where table_schema = 'app'`,
    sql<
      { tablename: string; policyname: string; permissive: string; roles: string[] }[]
    >`select tablename, policyname, permissive, roles from pg_policies where schemaname = 'app'`,
    sql<
      { tbl: string; tgname: string }[]
    >`select c.relname tbl, t.tgname from pg_trigger t join pg_class c on c.oid=t.tgrelid where not t.tgisinternal and c.relnamespace='app'::regnamespace`,
    sql<
      { table_name: string; privilege_type: string }[]
    >`select table_name, privilege_type from information_schema.role_table_grants where grantee='app_rw' and table_schema='app'`,
    sql<
      { tbl: string; ref: string; cols: string[] }[]
    >`select c.conrelid::regclass::text tbl, c.confrelid::regclass::text ref, (select array_agg(a.attname::text order by k.ord) from unnest(c.conkey) with ordinality k(attnum,ord) join pg_attribute a on a.attrelid=c.conrelid and a.attnum=k.attnum) cols from pg_constraint c where c.contype='f' and c.connamespace='app'::regnamespace`,
  ]);
  const violations: Violation[] = [];
  for (const table of tables) {
    const name = table.relname;
    const cols = new Set(columns.filter((c) => c.table_name === name).map((c) => c.column_name));
    const trigger = (predicate: (name: string) => boolean) =>
      triggers.some((t) => t.tbl === name && predicate(t.tgname));
    if (!globalTables.has(name)) {
      if (!cols.has("tenant_id"))
        violations.push({ table: name, rule: "tenant_id", detail: "missing tenant_id" });
      if (!table.relrowsecurity)
        violations.push({ table: name, rule: "rls_enabled", detail: "RLS disabled" });
      if (!table.relforcerowsecurity)
        violations.push({ table: name, rule: "rls_forced", detail: "RLS not forced" });
      if (!policies.some((p) => p.tablename === name && p.policyname === "tenant_isolation"))
        violations.push({
          table: name,
          rule: "tenant_isolation_policy",
          detail: "missing tenant_isolation",
        });
    }
    if (!noId.has(name) && !cols.has("id"))
      violations.push({ table: name, rule: "id_column", detail: "missing id" });
    if (!noCreatedAt.has(name) && !cols.has("created_at"))
      violations.push({ table: name, rule: "created_at", detail: "missing created_at" });
    for (const policy of policies.filter((p) => p.tablename === name)) {
      const appAuthOnly =
        policy.roles.includes("app_auth") &&
        !policy.roles.includes("app_rw") &&
        !policy.roles.includes("public");
      if (
        policy.permissive === "PERMISSIVE" &&
        !allowedPermissivePolicies.has(policy.policyname) &&
        !appAuthOnly
      ) {
        violations.push({
          table: name,
          rule: "extra_permissive_policy",
          detail: `${policy.policyname} is permissive and weakens tenant isolation`,
        });
      }
    }
    const gate = GATED_TABLES.get(name);
    if (gate !== undefined) {
      const policy = policies.find((p) => p.tablename === name && p.policyname === gate);
      if (policy === undefined || policy.permissive !== "RESTRICTIVE")
        violations.push({
          table: name,
          rule: "sensitive_gate",
          detail: `no RESTRICTIVE policy named ${gate} (spec:2076 — a permission gate is OR-ed away when permissive, SAH-033)`,
        });
    }
    const branchKey = cols.has("branch_id")
      ? "branch_id"
      : cols.has("home_branch_id")
        ? "home_branch_id"
        : null;
    if (
      !BRANCH_ISOLATION_EXEMPT.has(name) &&
      (branchKey !== null || BRANCH_ISOLATED_BY_WAREHOUSE.has(name))
    ) {
      const policy = policies.find(
        (p) => p.tablename === name && p.policyname === "branch_isolation",
      );
      if (!policy)
        violations.push({
          table: name,
          rule: "branch_isolation_policy",
          detail: `has a branch key (${branchKey ?? "warehouse_id → warehouse.branch_id"}) but no policy named branch_isolation (spec:2166)`,
        });
      else if (policy.permissive !== "RESTRICTIVE")
        violations.push({
          table: name,
          rule: "branch_isolation_policy",
          detail:
            "branch_isolation is PERMISSIVE — permissive policies OR together and the gate is voided by tenant_isolation (SAH-033)",
        });
    }
    if (name === "document_line") {
      const policy = policies.find(
        (p) => p.tablename === name && p.policyname === "document_parent_visibility",
      );
      if (!policy || policy.permissive !== "RESTRICTIVE")
        violations.push({
          table: name,
          rule: "document_parent_visibility_policy",
          detail: "document_line requires RESTRICTIVE document_parent_visibility (ADR 0062)",
        });
    }
    for (const column of cols)
      if (column.endsWith("_by") && !trigger((n) => n === `stamp_${column}`))
        violations.push({
          table: name,
          rule: "stamp_actor",
          detail: `${column} lacks stamp trigger`,
        });
    if (!AUDIT_EXEMPT.has(name) && !trigger((n) => n === "audit_row"))
      violations.push({ table: name, rule: "audit_trigger", detail: "missing audit_row" });
    if (IMMUTABLE.has(name)) {
      if (
        grants.some((g) => g.table_name === name && ["UPDATE", "DELETE"].includes(g.privilege_type))
      )
        violations.push({
          table: name,
          rule: "immutable_privileges",
          detail: "app_rw can mutate immutable table",
        });
      if (!trigger((n) => n.endsWith("_immutable")))
        violations.push({
          table: name,
          rule: "immutable_trigger",
          detail: "missing immutable trigger",
        });
    }
  }
  for (const fk of fks)
    if (!globalTables.has(fk.ref.replace(/^app\./, "")) && !fk.cols.includes("tenant_id"))
      violations.push({
        table: fk.tbl.replace(/^app\./, ""),
        rule: "composite_fk",
        detail: `${fk.ref} reference lacks tenant_id`,
      });
  return violations.toSorted(
    (a, b) => a.table.localeCompare(b.table) || a.rule.localeCompare(b.rule),
  );
}
