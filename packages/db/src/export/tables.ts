import type { Sql } from "postgres";

/**
 * The tenant export's table registry (spec:2186, ADR 0069). It decides **what leaves the system**: every
 * `app` table is either registered here with an explicit column list and a permission gate, or pinned whole in
 * `NEVER_EXPORTED` with its reason — `packages/db/test/export/tables.test.ts` fails on a table that is neither,
 * so a table a later migration adds does not leave the system until someone has reasoned about it.
 *
 * Every query is a literal tagged template authored here: never `select *`, never a table or column name
 * assembled from a string (§3.3, test 27). Values are wire-shaped as 7A's datasets are (7B amendment A3):
 * money, quantities, rates and `bigint`s as fixed-decimal strings, dates `YYYY-MM-DD`, timestamps RFC 3339 UTC
 * (to the microsecond — an export is lossless), `jsonb` as its JSON text and `bytea` as lower-case hex.
 */
export type ExportRow = Readonly<Record<string, string | number | boolean | null>>;

export interface ExportTable {
  /** The archive file base name and the `schema.json` key. Always the `app.` table's own name. */
  readonly name: string;
  /** EXPLICIT, in output order. A column added by a later migration must be added here deliberately, or it
   *  does not leave the system; `exportSchemaDocument` lists every column left out as `omitted`. */
  readonly columns: readonly string[];
  /** A permission code, as a plain `string` — `packages/db` may not import `PermissionCode` from
   *  `@dulja/contracts` (§3.1). `null` = included for anyone who holds `admin.data.export`. */
  readonly gate: string | null;
  /** `company`: the rows are bounded to the exported company by the query's own predicate (the job runs as
   *  the tenant's system principal, so RLS bounds the tenant and nothing else). `tenant`: the table has no
   *  company and every row of the tenant leaves — the currency list, roles, the members, the audit trail. */
  readonly scope: "company" | "tenant";
  /** `true` for a table whose rows belong to DOCUMENTS (a document, its lines, links, events, ledger rows and their
   *  dimensions, allocations, bank matches, custom-field values and attachments): its rows of a document whose type's
   *  module is in `MODULE_ROW_GATES` leave only when the requester holds that module's code (Phase 8 review, ADR 0069's
   *  8-review amendment). Set from `MODULE_BOUNDED_TABLES`, never by hand. */
  readonly moduleRows: boolean;
  readonly rows: (tx: Sql, companyId: string, scope: ExportRowScope) => Promise<ExportRow[]>;
}

/** Which modules' documents the requester may NOT see the rows of — `resolveExportGates` computes it from
 *  `MODULE_ROW_GATES`; a table with `moduleRows: false` ignores it. */
export interface ExportRowScope {
  readonly hiddenModules: readonly string[];
}

/** Every row: the scope of a requester who holds every module gate (and of a test reading a table whole). */
export const EVERY_ROW: ExportRowScope = { hiddenModules: [] };

/**
 * A document module whose documents' rows are gated INSIDE the ungated whole-ledger tables (Phase 8 review,
 * 2026-11-08; ADR 0069's 8-review amendment). A posted PAYROLL's lines are per-employee pay and a PAYROLL_PAYMENT's
 * lines name each employee beside their net, so they leave only under `hr.payroll.read` — §4.5.8's read code for the
 * `hr` module, the code `payroll_line` itself is gated on. The other modules stay as 7C shipped them: their documents
 * are the books an exporter holding `admin.data.export` exists to take.
 */
export const MODULE_ROW_GATES: Readonly<Record<string, string>> = {
  hr: "hr.payroll.read",
};

/** The tables `ExportTable.moduleRows` marks. `tables.test.ts` pins that every one of them really filters. */
export const MODULE_BOUNDED_TABLES: ReadonlySet<string> = new Set([
  "custom_field_value",
  "document",
  "document_line",
  "document_link",
  "document_event",
  "ledger_entry",
  "ledger_entry_dimension",
  "allocation",
  "bank_match",
  "attachment",
]);

/**
 * Columns that never leave the system, whatever the registry says; `["*"]` means the whole table. This is the
 * pinned half of ADR 0069: `tables.test.ts` asserts it against `EXPORT_TABLES` and `exportSchemaDocument`
 * throws if a pinned column reaches an export, so a future edit that "just adds one useful column" fails the
 * build instead of opening a side channel. Two kinds of entry, and each says which it is:
 *  - **secrets** — a credential, a credential's hash, a device key, a raw request body;
 *  - **plumbing** — operational state that is not a business record and would make two exports of the same
 *    books differ (ADR 0069's determinism).
 */
export const NEVER_EXPORTED: Readonly<Record<string, readonly string[]>> = {
  // secret: the identity provider's subject (`sub`) — an identity, not a book.
  principal: ["auth_subject"],
  // secret: an Argon2id PIN hash is a credential (6C, ADR 0060).
  pos_cashier: ["pin_hash"],
  // secret: the key a till signs every request with (6A, ADR 0055).
  pos_terminal: ["device_public_key"],
  // secret: the e-invoice authority's client id and the reference to its stored credential (5B, OD-15).
  company: ["einvoice_client_id", "einvoice_credential_ref"],
  // secret: the till's raw request body, verbatim — the facts a resolution needs are the other columns.
  needs_attention: ["payload"],
  // secret: SAH-038 — an object-store key never reaches the wire. An attachment's bytes travel under the
  // archive's attachments/ directory; a report run's artefact is regenerable from its definition.
  attachment: ["object_key"],
  // …and plumbing: `started_at` and `attempts` are the render worker's lease and fencing token (Phase 7 review,
  // finding 2) — operational state, not who ran what, and an export taken while a run is claimed would differ
  // from one taken after (second review, finding 3).
  report_run: ["object_key", "started_at", "attempts"],
  // secret: row images of every table, the gated ones included, so exporting them would defeat every gate at
  // once (the reason 7B keeps them out of the audit REPORT too). The trail itself is exported.
  audit_log: ["before", "after"],
  // secret: one-time enrolment code hashes (6A); nothing here is a record.
  terminal_enrolment: ["*"],
  // secret: request bodies and responses verbatim, kept 24 h for replay (ADR 0020).
  idempotency_key: ["*"],
  // plumbing: a till's signed-request replay window (6A, ADR 0055's amendment).
  terminal_request_guard: ["*"],
  // plumbing: the sync stream's deletion markers (6A); the catalogue rows themselves are exported.
  catalogue_tombstone: ["*"],
  // plumbing: a movement's booked cost awaiting `inventory.cost.replay` (0115); the booked figures are
  // `ledger_entry`, `cost_layer` and `cost_consumption`.
  cost_booking: ["*"],
  // plumbing: the export's own status resource — a running job is in it, so including it would make every
  // archive differ from the one before (ADR 0069).
  export_job: ["*"],
  // plumbing: the Phase 9 load's idempotence ledger (9B, migration 0102; contracts round 20 C16 item 6). Its business
  // half — what each legacy key was — leaves as the six master tables' `legacy_ref`; `source_hash` and `run_id`
  // record how a cut-over was rehearsed, not the books, and would make two exports of the same books differ.
  import_batch: ["*"],
  // plumbing: the cut-over load's own status resource (9B T9, migration 0103) — `export_job`'s reason: a running load
  // is in it, and `account_map` is the operator's input to a rehearsal, not the books. What a run loaded leaves as the
  // rows it created and their `legacy_ref`.
  import_run: ["*"],
  // plumbing: the GLOBAL permission catalogue (no tenant_id) shipped with the product; `role_permission`'s
  // codes are self-describing and `schema.json` is the documentation.
  permission: ["*"],
  // secret: 8A's encrypted identity, bank and statutory-reference record (migration 0081, ADR 0071). NARROWED by 8A
  // Task 14 (contracts round 16, A20) from the whole table to its nine ciphertext columns: the table is now a gated
  // EXPORT_TABLES row carrying metadata only, and these are precisely the columns that hold the secrets. They are
  // ciphertext under a key the archive does not contain, so exporting them would hand a recipient bytes nobody can
  // read while widening the blast radius of a leaked key; the plaintext leaves only through GET …/sensitive.
  employee_sensitive: [
    "national_id_enc",
    "passport_enc",
    "date_of_birth_enc",
    "residency_category_enc",
    "bank_account_enc",
    "epf_number_enc",
    "socso_number_enc",
    "tax_number_enc",
    "work_permit_expiry_enc",
  ],
};

/** A numeric key the select list re-casts to text is ordered by its TABLE column (`audit_log.seq`): a bare
 *  `order by seq` binds to the text output alias and sorts `"10"` before `"9"` (7C T8). Dates and the fixed-width
 *  UTC timestamps below sort the same as text. */
const TS = 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"';
const DAY = "YYYY-MM-DD";

const t = (
  name: string,
  gate: string | null,
  scope: ExportTable["scope"],
  columns: readonly string[],
  rows: (tx: Sql, companyId: string, scope: ExportRowScope) => Promise<ExportRow[]>,
): ExportTable => ({
  name,
  gate,
  scope,
  columns,
  moduleRows: MODULE_BOUNDED_TABLES.has(name),
  rows,
});

/** The ids of every document of a hidden module, as an uncorrelated subquery (planned once, hashed). Each
 *  `moduleRows` query writes `<its document column> not in (…)` — guarded by `is null or` where the column is
 *  nullable, because `null not in (…)` is null and would drop the row. An empty `hiddenModules` matches nothing. */
const hiddenDocuments = (tx: Sql, scope: ExportRowScope) =>
  tx`select hd.id from app.document hd join app.document_type ht on ht.id = hd.document_type_id
      where ht.module::text = any(${[...scope.hiddenModules]}::text[])`;

/** The v1 export set, in archive order. A slice that adds a table adds its row here or its pin above. */
export const EXPORT_TABLES: readonly ExportTable[] = [
  // ── the tenant and its company ───────────────────────────────────────────────────────────────────────
  t(
    "tenant",
    null,
    "tenant",
    ["id", "name", "created_at"],
    (tx) =>
      tx<ExportRow[]>`select id, name, to_char(created_at at time zone 'UTC', ${TS}) as created_at
      from app.tenant order by id`,
  ),
  t(
    "company",
    null,
    "company",
    [
      "id",
      "code",
      "name",
      "base_currency",
      "timezone",
      "fx_rounding_account_id",
      "costing_method",
      "einvoice_transmitter",
      "created_at",
    ],
    (tx, c) =>
      tx<
        ExportRow[]
      >`select id, code, name, base_currency, timezone, fx_rounding_account_id, costing_method,
        einvoice_transmitter, to_char(created_at at time zone 'UTC', ${TS}) as created_at
        from app.company where id = ${c}::uuid order by id`,
  ),

  // ── people and access ────────────────────────────────────────────────────────────────────────────────
  // The tenant's members, so every `*_by`, `attributed_to` and `*_principal_id` in the archive resolves to a
  // name. `app.principal` is global; the membership join is what bounds it to this tenant.
  t(
    "principal",
    null,
    "tenant",
    ["id", "kind", "display_name", "email", "created_at"],
    (tx) =>
      tx<ExportRow[]>`select p.id, p.kind::text as kind, p.display_name, p.email,
      to_char(p.created_at at time zone 'UTC', ${TS}) as created_at
      from app.principal p join app.membership m on m.principal_id = p.id order by p.id`,
  ),
  t(
    "membership",
    null,
    "tenant",
    ["principal_id", "created_at"],
    (tx) =>
      tx<
        ExportRow[]
      >`select principal_id, to_char(created_at at time zone 'UTC', ${TS}) as created_at
      from app.membership order by principal_id`,
  ),
  t(
    "role",
    null,
    "tenant",
    ["id", "code", "name_en", "name_ar", "description", "is_system", "created_at"],
    (tx) =>
      tx<ExportRow[]>`select id, code, name_en, name_ar, description, is_system,
        to_char(created_at at time zone 'UTC', ${TS}) as created_at
        from app.role order by code, id`,
  ),
  t(
    "role_permission",
    null,
    "tenant",
    ["role_id", "permission_code"],
    (tx) =>
      tx<ExportRow[]>`select role_id, permission_code from app.role_permission
      order by role_id, permission_code`,
  ),
  t(
    "role_assignment",
    null,
    "company",
    ["principal_id", "role_id", "granted_by", "granted_at", "expires_at"],
    (tx, c) =>
      tx<ExportRow[]>`select principal_id, role_id, granted_by,
        to_char(granted_at at time zone 'UTC', ${TS}) as granted_at,
        to_char(expires_at at time zone 'UTC', ${TS}) as expires_at
        from app.role_assignment where company_id = ${c}::uuid order by principal_id, role_id`,
  ),
  t(
    "role_assignment_branch",
    null,
    "company",
    ["principal_id", "role_id", "branch_id"],
    (tx, c) =>
      tx<ExportRow[]>`select principal_id, role_id, branch_id from app.role_assignment_branch
        where company_id = ${c}::uuid order by principal_id, role_id, branch_id`,
  ),

  // ── configuration ────────────────────────────────────────────────────────────────────────────────────
  t(
    "currency",
    null,
    "tenant",
    [
      "id",
      "code",
      "name_en",
      "name_ar",
      "minor_units",
      "pos_rounding_increment",
      "rounding_mode",
      "archived_at",
      "created_at",
    ],
    (tx) =>
      tx<ExportRow[]>`select id, code, name_en, name_ar, minor_units,
        pos_rounding_increment::text as pos_rounding_increment, rounding_mode,
        to_char(archived_at at time zone 'UTC', ${TS}) as archived_at,
        to_char(created_at at time zone 'UTC', ${TS}) as created_at
        from app.currency order by code, id`,
  ),
  t(
    "exchange_rate",
    null,
    "company",
    [
      "id",
      "from_currency",
      "to_currency",
      "rate",
      "effective_from",
      "source",
      "entered_by",
      "created_at",
    ],
    (tx, c) =>
      tx<ExportRow[]>`select id, from_currency, to_currency, rate::text as rate,
        to_char(effective_from, ${DAY}) as effective_from, source, entered_by,
        to_char(created_at at time zone 'UTC', ${TS}) as created_at
        from app.exchange_rate where company_id = ${c}::uuid
        order by effective_from, from_currency, to_currency, id`,
  ),
  t(
    "account",
    null,
    "company",
    [
      "id",
      "code",
      "name_en",
      "name_ar",
      "type",
      "parent_id",
      "is_group",
      "currency",
      "archived_at",
      // 9B's 0101 (contracts §4.13.3): the source system's own identifier is part of the books (SAH-051).
      "legacy_ref",
      "created_at",
    ],
    (tx, c) =>
      tx<
        ExportRow[]
      >`select id, code, name_en, name_ar, type::text as type, parent_id, is_group, currency,
        to_char(archived_at at time zone 'UTC', ${TS}) as archived_at, legacy_ref,
        to_char(created_at at time zone 'UTC', ${TS}) as created_at
        from app.account where company_id = ${c}::uuid order by code, id`,
  ),
  t(
    "fiscal_period",
    null,
    "company",
    [
      "id",
      "starts_on",
      "ends_on",
      "status",
      "closed_by",
      "closed_at",
      "reopen_reason",
      "created_at",
    ],
    (tx, c) =>
      tx<
        ExportRow[]
      >`select id, to_char(starts_on, ${DAY}) as starts_on, to_char(ends_on, ${DAY}) as ends_on,
        status::text as status, closed_by, to_char(closed_at at time zone 'UTC', ${TS}) as closed_at,
        reopen_reason, to_char(created_at at time zone 'UTC', ${TS}) as created_at
        from app.fiscal_period where company_id = ${c}::uuid order by starts_on, id`,
  ),
  t(
    "dimension_type",
    null,
    "company",
    ["id", "code", "name_en", "name_ar", "created_at"],
    (tx, c) =>
      tx<ExportRow[]>`select id, code, name_en, name_ar,
        to_char(created_at at time zone 'UTC', ${TS}) as created_at
        from app.dimension_type where company_id = ${c}::uuid order by code, id`,
  ),
  t(
    "dimension_value",
    null,
    "company",
    [
      "id",
      "dimension_type_id",
      "code",
      "name_en",
      "name_ar",
      "parent_id",
      "archived_at",
      "created_at",
    ],
    (tx, c) =>
      tx<
        ExportRow[]
      >`select dv.id, dv.dimension_type_id, dv.code, dv.name_en, dv.name_ar, dv.parent_id,
        to_char(dv.archived_at at time zone 'UTC', ${TS}) as archived_at,
        to_char(dv.created_at at time zone 'UTC', ${TS}) as created_at
        from app.dimension_value dv join app.dimension_type dt on dt.id = dv.dimension_type_id
        where dt.company_id = ${c}::uuid order by dt.code, dv.code, dv.id`,
  ),
  t(
    "document_type",
    null,
    "company",
    ["id", "code", "name_en", "name_ar", "module", "archived_at", "created_at"],
    (tx, c) =>
      tx<ExportRow[]>`select id, code, name_en, name_ar, module,
        to_char(archived_at at time zone 'UTC', ${TS}) as archived_at,
        to_char(created_at at time zone 'UTC', ${TS}) as created_at
        from app.document_type where company_id = ${c}::uuid order by code, id`,
  ),
  t(
    "posting_policy",
    null,
    "company",
    ["id", "document_type_id", "version", "effective_from", "definition", "created_at"],
    (tx, c) =>
      tx<ExportRow[]>`select pp.id, pp.document_type_id, pp.version,
        to_char(pp.effective_from, ${DAY}) as effective_from, pp.definition::text as definition,
        to_char(pp.created_at at time zone 'UTC', ${TS}) as created_at
        from app.posting_policy pp join app.document_type dt on dt.id = pp.document_type_id
        where dt.company_id = ${c}::uuid order by dt.code, pp.version, pp.id`,
  ),
  t(
    "custom_field_definition",
    null,
    "company",
    [
      "id",
      "entity",
      "document_type_id",
      "code",
      "name_en",
      "name_ar",
      "kind",
      "required",
      "options",
      "indexed",
      "archived_at",
      "created_at",
    ],
    (tx, c) =>
      tx<ExportRow[]>`select id, entity, document_type_id, code, name_en, name_ar, kind, required,
        options::text as options, indexed, to_char(archived_at at time zone 'UTC', ${TS}) as archived_at,
        to_char(created_at at time zone 'UTC', ${TS}) as created_at
        from app.custom_field_definition where company_id = ${c}::uuid order by entity, code, id`,
  ),
  t(
    "custom_field_value",
    null,
    "company",
    ["id", "definition_id", "entity_id", "value", "created_at"],
    (tx, c, scope) =>
      tx<ExportRow[]>`select v.id, v.definition_id, v.entity_id, v.value::text as value,
        to_char(v.created_at at time zone 'UTC', ${TS}) as created_at
        from app.custom_field_value v join app.custom_field_definition d on d.id = v.definition_id
        where d.company_id = ${c}::uuid and v.entity_id not in (${hiddenDocuments(tx, scope)})
        order by v.definition_id, v.entity_id, v.id`,
  ),
  t(
    "payment_term",
    null,
    "company",
    [
      "id",
      "code",
      "name_en",
      "name_ar",
      "due_days",
      "discount_days",
      "discount_pct",
      "archived_at",
      "created_at",
    ],
    (tx, c) =>
      tx<ExportRow[]>`select id, code, name_en, name_ar, due_days, discount_days,
        discount_pct::text as discount_pct, to_char(archived_at at time zone 'UTC', ${TS}) as archived_at,
        to_char(created_at at time zone 'UTC', ${TS}) as created_at
        from app.payment_term where company_id = ${c}::uuid order by code, id`,
  ),
  t(
    "print_template",
    null,
    "company",
    [
      "id",
      "document_type_id",
      "code",
      "version",
      "name_en",
      "name_ar",
      "engine",
      "source",
      "paper",
      "created_at",
    ],
    (tx, c) =>
      tx<
        ExportRow[]
      >`select id, document_type_id, code, version, name_en, name_ar, engine, source, paper,
        to_char(created_at at time zone 'UTC', ${TS}) as created_at
        from app.print_template where company_id = ${c}::uuid order by code, version, id`,
  ),

  // ── parties, items and the catalogue ─────────────────────────────────────────────────────────────────
  t(
    "party",
    null,
    "company",
    [
      "id",
      "kind",
      "code",
      "name_en",
      "name_ar",
      "receivable_account_id",
      "payable_account_id",
      "currency",
      "tax_registration",
      "email",
      "phone",
      "address",
      "credit_limit",
      "credit_hold",
      "payment_term_id",
      "price_list_id",
      "archived_at",
      // 9B's 0101 (contracts §4.13.3): the source system's own identifier is part of the books (SAH-051).
      "legacy_ref",
      "created_at",
    ],
    (tx, c) =>
      tx<
        ExportRow[]
      >`select id, kind, code, name_en, name_ar, receivable_account_id, payable_account_id,
        currency, tax_registration, email, phone, address::text as address,
        credit_limit::text as credit_limit, credit_hold, payment_term_id, price_list_id,
        to_char(archived_at at time zone 'UTC', ${TS}) as archived_at, legacy_ref,
        to_char(created_at at time zone 'UTC', ${TS}) as created_at
        from app.party where company_id = ${c}::uuid order by kind, code, id`,
  ),
  t(
    "unit_of_measure",
    null,
    "company",
    ["id", "code", "name_en", "name_ar", "created_at"],
    (tx, c) =>
      tx<ExportRow[]>`select id, code, name_en, name_ar,
        to_char(created_at at time zone 'UTC', ${TS}) as created_at
        from app.unit_of_measure where company_id = ${c}::uuid order by code, id`,
  ),
  t(
    "item",
    null,
    "company",
    [
      "id",
      "code",
      "name_en",
      "name_ar",
      "kind",
      "base_unit_id",
      "barcode",
      "revenue_account_id",
      "inventory_account_id",
      "cogs_account_id",
      "expense_account_id",
      "tax_code_id",
      "track_lots",
      "shelf_life_days",
      "archived_at",
      // 9B's 0101 (contracts §4.13.3): the source system's own identifier is part of the books (SAH-051).
      "legacy_ref",
      "created_at",
    ],
    (tx, c) =>
      tx<
        ExportRow[]
      >`select id, code, name_en, name_ar, kind, base_unit_id, barcode, revenue_account_id,
        inventory_account_id, cogs_account_id, expense_account_id, tax_code_id, track_lots, shelf_life_days,
        to_char(archived_at at time zone 'UTC', ${TS}) as archived_at, legacy_ref,
        to_char(created_at at time zone 'UTC', ${TS}) as created_at
        from app.item where company_id = ${c}::uuid order by code, id`,
  ),
  t(
    "unit_conversion",
    null,
    "company",
    ["id", "item_id", "unit_id", "numerator", "denominator", "created_at"],
    (tx, c) =>
      tx<ExportRow[]>`select uc.id, uc.item_id, uc.unit_id, uc.numerator::text as numerator,
        uc.denominator::text as denominator, to_char(uc.created_at at time zone 'UTC', ${TS}) as created_at
        from app.unit_conversion uc join app.item i on i.id = uc.item_id
        where i.company_id = ${c}::uuid order by i.code, uc.unit_id, uc.id`,
  ),
  t(
    "variant",
    null,
    "company",
    ["id", "item_id", "code", "name_en", "name_ar", "attributes", "created_at"],
    (tx, c) =>
      tx<
        ExportRow[]
      >`select v.id, v.item_id, v.code, v.name_en, v.name_ar, v.attributes::text as attributes,
        to_char(v.created_at at time zone 'UTC', ${TS}) as created_at
        from app.variant v join app.item i on i.id = v.item_id
        where i.company_id = ${c}::uuid order by i.code, v.code, v.id`,
  ),
  t(
    "warehouse",
    null,
    "company",
    [
      "id",
      "code",
      "name_en",
      "name_ar",
      "kind",
      "branch_id",
      "parent_id",
      "archived_at",
      "created_at",
    ],
    (tx, c) =>
      tx<ExportRow[]>`select id, code, name_en, name_ar, kind, branch_id, parent_id,
        to_char(archived_at at time zone 'UTC', ${TS}) as archived_at,
        to_char(created_at at time zone 'UTC', ${TS}) as created_at
        from app.warehouse where company_id = ${c}::uuid order by code, id`,
  ),
  t(
    "lot",
    null,
    "company",
    [
      "id",
      "item_id",
      "code",
      "expires_on",
      "manufactured_on",
      "archived_at",
      // 9B's 0101 (contracts §4.13.3): the source system's own identifier is part of the books (SAH-051).
      "legacy_ref",
      "created_at",
    ],
    (tx, c) =>
      tx<ExportRow[]>`select id, item_id, code, to_char(expires_on, ${DAY}) as expires_on,
        to_char(manufactured_on, ${DAY}) as manufactured_on,
        to_char(archived_at at time zone 'UTC', ${TS}) as archived_at, legacy_ref,
        to_char(created_at at time zone 'UTC', ${TS}) as created_at
        from app.lot where company_id = ${c}::uuid order by item_id, code, id`,
  ),
  t(
    "price_list",
    null,
    "company",
    [
      "id",
      "code",
      "name_en",
      "name_ar",
      "currency",
      "customer_kind",
      "branch_id",
      "valid_from",
      "valid_to",
      "archived_at",
      "created_at",
    ],
    (tx, c) =>
      tx<ExportRow[]>`select id, code, name_en, name_ar, currency, customer_kind, branch_id,
        to_char(valid_from, ${DAY}) as valid_from, to_char(valid_to, ${DAY}) as valid_to,
        to_char(archived_at at time zone 'UTC', ${TS}) as archived_at,
        to_char(created_at at time zone 'UTC', ${TS}) as created_at
        from app.price_list where company_id = ${c}::uuid order by code, id`,
  ),
  t(
    "price_list_line",
    null,
    "company",
    [
      "id",
      "price_list_id",
      "item_id",
      "unit_id",
      "min_quantity",
      "unit_price",
      "archived_at",
      "created_at",
    ],
    (tx, c) =>
      tx<ExportRow[]>`select pll.id, pll.price_list_id, pll.item_id, pll.unit_id,
        pll.min_quantity::text as min_quantity, pll.unit_price::text as unit_price,
        to_char(pll.archived_at at time zone 'UTC', ${TS}) as archived_at,
        to_char(pll.created_at at time zone 'UTC', ${TS}) as created_at
        from app.price_list_line pll join app.price_list pl on pl.id = pll.price_list_id
        where pl.company_id = ${c}::uuid order by pl.code, pll.item_id, pll.min_quantity, pll.id`,
  ),
  t(
    "promotion",
    null,
    "company",
    [
      "id",
      "code",
      "name_en",
      "name_ar",
      "kind",
      "definition",
      "starts_at",
      "ends_at",
      "branch_id",
      "created_at",
    ],
    (tx, c) =>
      tx<ExportRow[]>`select id, code, name_en, name_ar, kind, definition::text as definition,
        to_char(starts_at at time zone 'UTC', ${TS}) as starts_at,
        to_char(ends_at at time zone 'UTC', ${TS}) as ends_at, branch_id,
        to_char(created_at at time zone 'UTC', ${TS}) as created_at
        from app.promotion where company_id = ${c}::uuid order by code, id`,
  ),

  // ── documents and the ledger ─────────────────────────────────────────────────────────────────────────
  t(
    "document_series",
    null,
    "company",
    ["series", "fiscal_period_id", "next_number"],
    (tx, c) =>
      tx<ExportRow[]>`select series, fiscal_period_id, next_number::text as next_number
        from app.document_series where company_id = ${c}::uuid order by series, fiscal_period_id`,
  ),
  t(
    "document_number_void",
    null,
    "company",
    ["series", "fiscal_period_id", "number", "reason", "voided_by", "voided_at"],
    (tx, c) =>
      tx<ExportRow[]>`select series, fiscal_period_id, number::text as number, reason, voided_by,
        to_char(voided_at at time zone 'UTC', ${TS}) as voided_at
        from app.document_number_void where company_id = ${c}::uuid
        order by series, fiscal_period_id, document_number_void.number`,
  ),
  t(
    "document",
    null,
    "company",
    [
      "id",
      "document_type_id",
      "posting_policy_id",
      "status",
      "series",
      "fiscal_period_id",
      "number",
      "effective_date",
      "party_id",
      "currency",
      "exchange_rate",
      "rate_source",
      "reverses_document_id",
      "client_ref",
      "branch_id",
      "warehouse_id",
      "to_warehouse_id",
      "payment_term_id",
      "tax_inclusive",
      "terminal_id",
      "shift_id",
      "attributed_to",
      "created_by",
      "posted_by",
      "posted_at",
      "posting_seq",
      "notes",
      // 9B's 0101 (contracts §4.13.3): the source system's own identifier is part of the books (SAH-051).
      "legacy_ref",
      "created_at",
    ],
    (tx, c, scope) =>
      tx<
        ExportRow[]
      >`select id, document_type_id, posting_policy_id, status::text as status, series,
        fiscal_period_id, number::text as number, to_char(effective_date, ${DAY}) as effective_date, party_id,
        currency, exchange_rate::text as exchange_rate, rate_source, reverses_document_id, client_ref,
        branch_id, warehouse_id, to_warehouse_id, payment_term_id, tax_inclusive, terminal_id, shift_id,
        attributed_to, created_by, posted_by, to_char(posted_at at time zone 'UTC', ${TS}) as posted_at,
        posting_seq::text as posting_seq, notes, legacy_ref,
        to_char(created_at at time zone 'UTC', ${TS}) as created_at
        from app.document where company_id = ${c}::uuid and id not in (${hiddenDocuments(tx, scope)})
        order by effective_date, document.posting_seq nulls last, id`,
  ),
  // `cost` is left out on purpose: it is the issue's valuation, the figure `inventory_movement.value` carries
  // behind `inventory.cost.read` (3B removed that authority from roles that read stock). `schema.json` lists
  // it under `omitted`.
  t(
    "document_line",
    null,
    "company",
    [
      "id",
      "document_id",
      "line_no",
      "kind",
      "description",
      "account_id",
      "debit",
      "credit",
      "dimensions",
      "custom_fields",
      "item_id",
      "warehouse_id",
      "lot_id",
      "unit_id",
      "quantity",
      "unit_quantity",
      "unit_price",
      "discount",
      "amount",
      "tax_code_id",
      "tax_amount",
      "total_incl_tax",
      "counted_quantity",
      "expected_quantity",
      "created_at",
    ],
    (tx, c, scope) =>
      tx<
        ExportRow[]
      >`select dl.id, dl.document_id, dl.line_no, dl.kind, dl.description, dl.account_id,
        dl.debit::text as debit, dl.credit::text as credit, dl.dimensions::text as dimensions,
        dl.custom_fields::text as custom_fields, dl.item_id, dl.warehouse_id, dl.lot_id, dl.unit_id,
        dl.quantity::text as quantity, dl.unit_quantity::text as unit_quantity,
        dl.unit_price::text as unit_price, dl.discount::text as discount, dl.amount::text as amount,
        dl.tax_code_id, dl.tax_amount::text as tax_amount, dl.total_incl_tax::text as total_incl_tax,
        dl.counted_quantity::text as counted_quantity, dl.expected_quantity::text as expected_quantity,
        to_char(dl.created_at at time zone 'UTC', ${TS}) as created_at
        from app.document_line dl
        where dl.company_id = ${c}::uuid and dl.document_id not in (${hiddenDocuments(tx, scope)})
        order by dl.document_id, dl.line_no`,
  ),
  t(
    "document_link",
    null,
    "company",
    [
      "id",
      "source_document_id",
      "source_line_id",
      "target_document_id",
      "target_line_id",
      "link_kind",
      "quantity",
      "amount",
      "created_at",
    ],
    (tx, c, scope) =>
      tx<
        ExportRow[]
      >`select id, source_document_id, source_line_id, target_document_id, target_line_id,
        link_kind, quantity::text as quantity, amount::text as amount,
        to_char(created_at at time zone 'UTC', ${TS}) as created_at
        from app.document_link where company_id = ${c}::uuid
          and (source_document_id is null or source_document_id not in (${hiddenDocuments(tx, scope)}))
          and (target_document_id is null or target_document_id not in (${hiddenDocuments(tx, scope)}))
        order by created_at, id`,
  ),
  // Gated as 7B's `accounting.document_event_log` is: a document's event history is audit evidence (spec:2163).
  t(
    "document_event",
    "admin.audit_log.read",
    "company",
    [
      "id",
      "document_id",
      "event_kind",
      "from_status",
      "to_status",
      "override_code",
      "actor_id",
      "attributed_to",
      "occurred_at",
      "reason",
      "approved_base_total",
      "approved_stock_digest",
      "created_at",
    ],
    (tx, c, scope) =>
      tx<ExportRow[]>`select id, document_id, event_kind, from_status::text as from_status,
        to_status::text as to_status, override_code, actor_id, attributed_to,
        to_char(occurred_at at time zone 'UTC', ${TS}) as occurred_at, reason,
        approved_base_total::text as approved_base_total, approved_stock_digest,
        to_char(created_at at time zone 'UTC', ${TS}) as created_at
        from app.document_event
        where company_id = ${c}::uuid and document_id not in (${hiddenDocuments(tx, scope)})
        order by occurred_at, id`,
  ),
  t(
    "ledger_entry",
    null,
    "company",
    [
      "id",
      "document_id",
      "line_no",
      "account_id",
      "currency",
      "exchange_rate",
      "debit",
      "credit",
      "base_debit",
      "base_credit",
      "effective_date",
      "fiscal_period_id",
      "posting_policy_id",
      "posted_by",
      "posted_at",
    ],
    (tx, c, scope) =>
      tx<ExportRow[]>`select id, document_id, line_no, account_id, currency,
        exchange_rate::text as exchange_rate, debit::text as debit, credit::text as credit,
        base_debit::text as base_debit, base_credit::text as base_credit,
        to_char(effective_date, ${DAY}) as effective_date, fiscal_period_id, posting_policy_id, posted_by,
        to_char(posted_at at time zone 'UTC', ${TS}) as posted_at
        from app.ledger_entry
        where company_id = ${c}::uuid and document_id not in (${hiddenDocuments(tx, scope)})
        order by effective_date, document_id, line_no, id`,
  ),
  t(
    "ledger_entry_dimension",
    null,
    "company",
    ["entry_id", "dimension_type_id", "dimension_value_id"],
    (tx, c, scope) =>
      tx<ExportRow[]>`select led.entry_id, led.dimension_type_id, led.dimension_value_id
        from app.ledger_entry_dimension led join app.ledger_entry le on le.id = led.entry_id
        where le.company_id = ${c}::uuid and le.document_id not in (${hiddenDocuments(tx, scope)})
        order by led.entry_id, led.dimension_type_id`,
  ),
  t(
    "account_balance",
    null,
    "company",
    ["account_id", "fiscal_period_id", "currency", "debit", "credit", "base_debit", "base_credit"],
    (tx, c) =>
      tx<ExportRow[]>`select account_id, fiscal_period_id, currency, debit::text as debit,
        credit::text as credit, base_debit::text as base_debit, base_credit::text as base_credit
        from app.account_balance where company_id = ${c}::uuid
        order by account_id, fiscal_period_id, currency`,
  ),

  // ── AR / AP and the bank ─────────────────────────────────────────────────────────────────────────────
  t(
    "allocation",
    null,
    "company",
    [
      "id",
      "party_id",
      "settlement_document_id",
      "settled_document_id",
      "amount",
      "settlement_amount",
      "base_amount",
      "fx_difference",
      "effective_date",
      "allocated_by",
      "unallocated_at",
      "unallocated_by",
      "unallocation_reason",
      "unallocated_on",
      "created_at",
    ],
    (tx, c, scope) =>
      tx<ExportRow[]>`select id, party_id, settlement_document_id, settled_document_id,
        amount::text as amount, settlement_amount::text as settlement_amount,
        base_amount::text as base_amount, fx_difference::text as fx_difference,
        to_char(effective_date, ${DAY}) as effective_date, allocated_by,
        to_char(unallocated_at at time zone 'UTC', ${TS}) as unallocated_at, unallocated_by,
        unallocation_reason, to_char(unallocated_on, ${DAY}) as unallocated_on,
        to_char(created_at at time zone 'UTC', ${TS}) as created_at
        from app.allocation where company_id = ${c}::uuid
          and settlement_document_id not in (${hiddenDocuments(tx, scope)})
          and settled_document_id not in (${hiddenDocuments(tx, scope)})
        order by created_at, id`,
  ),
  t(
    "party_ageing",
    null,
    "company",
    ["party_id", "currency", "as_of", "bucket", "amount", "base_amount"],
    (tx, c) =>
      tx<ExportRow[]>`select party_id, currency, to_char(as_of, ${DAY}) as as_of, bucket,
        amount::text as amount, base_amount::text as base_amount
        from app.party_ageing where company_id = ${c}::uuid order by as_of, party_id, currency, bucket`,
  ),
  t(
    "bank_statement",
    null,
    "company",
    [
      "id",
      "bank_account_id",
      "statement_date",
      "opening_balance",
      "closing_balance",
      "currency",
      "source_file_attachment_id",
      "imported_by",
      "created_at",
    ],
    (tx, c) =>
      tx<ExportRow[]>`select id, bank_account_id, to_char(statement_date, ${DAY}) as statement_date,
        opening_balance::text as opening_balance, closing_balance::text as closing_balance, currency,
        source_file_attachment_id, imported_by, to_char(created_at at time zone 'UTC', ${TS}) as created_at
        from app.bank_statement where company_id = ${c}::uuid order by statement_date, id`,
  ),
  t(
    "bank_statement_line",
    null,
    "company",
    [
      "id",
      "statement_id",
      "line_no",
      "value_date",
      "description",
      "reference",
      "amount",
      "created_at",
    ],
    (tx, c) =>
      tx<ExportRow[]>`select id, statement_id, line_no, to_char(value_date, ${DAY}) as value_date,
        description, reference, amount::text as amount,
        to_char(created_at at time zone 'UTC', ${TS}) as created_at
        from app.bank_statement_line where company_id = ${c}::uuid order by statement_id, line_no`,
  ),
  t(
    "bank_match",
    null,
    "company",
    [
      "id",
      "statement_line_id",
      "reconcilable_kind",
      "reconcilable_document_id",
      "amount",
      "matched_by",
      "matched_at",
      "unmatched_by",
      "unmatched_at",
      "unmatch_reason",
      "created_at",
    ],
    (tx, c, scope) =>
      tx<ExportRow[]>`select id, statement_line_id, reconcilable_kind, reconcilable_document_id,
        amount::text as amount, matched_by, to_char(matched_at at time zone 'UTC', ${TS}) as matched_at,
        unmatched_by, to_char(unmatched_at at time zone 'UTC', ${TS}) as unmatched_at, unmatch_reason,
        to_char(created_at at time zone 'UTC', ${TS}) as created_at
        from app.bank_match where company_id = ${c}::uuid
          and (reconcilable_document_id is null
               or reconcilable_document_id not in (${hiddenDocuments(tx, scope)}))
        order by matched_at, id`,
  ),

  // ── inventory — quantities ungated, every cost figure behind inventory.cost.read (3B) ────────────────
  t(
    "stock_on_hand",
    null,
    "company",
    ["item_id", "warehouse_id", "lot_id", "quantity"],
    (tx, c) =>
      tx<ExportRow[]>`select item_id, warehouse_id, lot_id, quantity::text as quantity
        from app.stock_on_hand where company_id = ${c}::uuid
        order by item_id, warehouse_id, lot_id nulls first`,
  ),
  // `value` is the movement's cost, so the whole ledger of movements is gated with it.
  t(
    "inventory_movement",
    "inventory.cost.read",
    "company",
    [
      "id",
      "document_id",
      "line_no",
      "movement_no",
      "item_id",
      "warehouse_id",
      "lot_id",
      "unit_id",
      "quantity",
      "value",
      "effective_date",
      "posting_seq",
      "posted_by",
      "posted_at",
      "created_at",
    ],
    (tx, c) =>
      tx<
        ExportRow[]
      >`select id, document_id, line_no, movement_no, item_id, warehouse_id, lot_id, unit_id,
        quantity::text as quantity, value::text as value, to_char(effective_date, ${DAY}) as effective_date,
        posting_seq::text as posting_seq, posted_by, to_char(posted_at at time zone 'UTC', ${TS}) as posted_at,
        to_char(created_at at time zone 'UTC', ${TS}) as created_at
        from app.inventory_movement where company_id = ${c}::uuid
        order by effective_date, inventory_movement.posting_seq, movement_no, id`,
  ),
  t(
    "cost_layer",
    "inventory.cost.read",
    "company",
    [
      "id",
      "item_id",
      "warehouse_id",
      "lot_id",
      "movement_id",
      "qty_in",
      "unit_cost",
      "qty_remaining",
      "value",
      "effective_at",
      "sequence",
      "invalidated_at",
      "created_at",
    ],
    (tx, c) =>
      tx<ExportRow[]>`select id, item_id, warehouse_id, lot_id, movement_id, qty_in::text as qty_in,
        unit_cost::text as unit_cost, qty_remaining::text as qty_remaining, value::text as value,
        to_char(effective_at, ${DAY}) as effective_at, sequence::text as sequence,
        to_char(invalidated_at at time zone 'UTC', ${TS}) as invalidated_at,
        to_char(created_at at time zone 'UTC', ${TS}) as created_at
        from app.cost_layer where company_id = ${c}::uuid order by item_id, warehouse_id, cost_layer.sequence, id`,
  ),
  t(
    "cost_consumption",
    "inventory.cost.read",
    "company",
    [
      "id",
      "movement_id",
      "layer_id",
      "quantity",
      "unit_cost",
      "value",
      "invalidated_at",
      "created_at",
    ],
    (tx, c) =>
      tx<ExportRow[]>`select id, movement_id, layer_id, quantity::text as quantity,
        unit_cost::text as unit_cost, value::text as value,
        to_char(invalidated_at at time zone 'UTC', ${TS}) as invalidated_at,
        to_char(created_at at time zone 'UTC', ${TS}) as created_at
        from app.cost_consumption where company_id = ${c}::uuid order by movement_id, layer_id, id`,
  ),
  t(
    "stock_valuation",
    "inventory.cost.read",
    "company",
    ["item_id", "warehouse_id", "as_of", "quantity", "value"],
    (tx, c) =>
      tx<ExportRow[]>`select item_id, warehouse_id, to_char(as_of, ${DAY}) as as_of,
        quantity::text as quantity, value::text as value
        from app.stock_valuation where company_id = ${c}::uuid order by as_of, item_id, warehouse_id`,
  ),
  t(
    "landed_cost_allocation",
    "inventory.cost.read",
    "company",
    [
      "id",
      "shipment_document_id",
      "cost_line_id",
      "target_line_id",
      "method",
      "allocated_amount",
      "created_at",
    ],
    (tx, c) =>
      tx<ExportRow[]>`select id, shipment_document_id, cost_line_id, target_line_id, method,
        allocated_amount::text as allocated_amount,
        to_char(created_at at time zone 'UTC', ${TS}) as created_at
        from app.landed_cost_allocation where company_id = ${c}::uuid
        order by shipment_document_id, cost_line_id, target_line_id, id`,
  ),
  t(
    "item_profitability",
    "inventory.cost.read",
    "company",
    ["item_id", "fiscal_period_id", "quantity_sold", "revenue_base", "cogs_base", "margin_base"],
    (tx, c) =>
      tx<ExportRow[]>`select item_id, fiscal_period_id, quantity_sold::text as quantity_sold,
        revenue_base::text as revenue_base, cogs_base::text as cogs_base, margin_base::text as margin_base
        from app.item_profitability where company_id = ${c}::uuid order by fiscal_period_id, item_id`,
  ),

  // ── tax and e-invoicing — gated as 5A's and 5B's own reads are ───────────────────────────────────────
  t(
    "tax_regime",
    "accounting.tax.manage",
    "company",
    [
      "id",
      "code",
      "jurisdiction",
      "version",
      "effective_from",
      "effective_to",
      "name_en",
      "name_ar",
      "source",
      "created_at",
    ],
    (tx, c) =>
      tx<
        ExportRow[]
      >`select id, code, jurisdiction, version, to_char(effective_from, ${DAY}) as effective_from,
        to_char(effective_to, ${DAY}) as effective_to, name_en, name_ar, source,
        to_char(created_at at time zone 'UTC', ${TS}) as created_at
        from app.tax_regime where company_id = ${c}::uuid order by code, version, id`,
  ),
  t(
    "tax_code",
    "accounting.tax.manage",
    "company",
    [
      "id",
      "regime_id",
      "code",
      "name_en",
      "name_ar",
      "rate",
      "kind",
      "rounding_mode",
      "output_account_id",
      "input_account_id",
      "effective_from",
      "effective_to",
      "archived_at",
      "created_at",
    ],
    (tx, c) =>
      tx<
        ExportRow[]
      >`select id, regime_id, code, name_en, name_ar, rate::text as rate, kind, rounding_mode,
        output_account_id, input_account_id, to_char(effective_from, ${DAY}) as effective_from,
        to_char(effective_to, ${DAY}) as effective_to,
        to_char(archived_at at time zone 'UTC', ${TS}) as archived_at,
        to_char(created_at at time zone 'UTC', ${TS}) as created_at
        from app.tax_code where company_id = ${c}::uuid order by code, effective_from, id`,
  ),
  t(
    "tax_transaction",
    "accounting.tax.manage",
    "company",
    [
      "id",
      "document_id",
      "line_no",
      "tax_code_id",
      "regime_id",
      "base",
      "tax",
      "base_base",
      "tax_base",
      "effective_date",
      "fiscal_period_id",
      "posting_seq",
      "created_at",
    ],
    (tx, c) =>
      tx<ExportRow[]>`select id, document_id, line_no, tax_code_id, regime_id, base::text as base,
        tax::text as tax, base_base::text as base_base, tax_base::text as tax_base,
        to_char(effective_date, ${DAY}) as effective_date, fiscal_period_id, posting_seq::text as posting_seq,
        to_char(created_at at time zone 'UTC', ${TS}) as created_at
        from app.tax_transaction where company_id = ${c}::uuid
        order by effective_date, document_id, line_no, id`,
  ),
  t(
    "tax_return",
    "accounting.tax.manage",
    "company",
    [
      "id",
      "regime_id",
      "period_start",
      "period_end",
      "status",
      "payload",
      "payload_sha256",
      "generated_by",
      "filed_at",
      "attachment_id",
      "created_at",
    ],
    (tx, c) =>
      tx<ExportRow[]>`select id, regime_id, to_char(period_start, ${DAY}) as period_start,
        to_char(period_end, ${DAY}) as period_end, status, payload,
        encode(payload_sha256, 'hex') as payload_sha256, generated_by,
        to_char(filed_at at time zone 'UTC', ${TS}) as filed_at, attachment_id,
        to_char(created_at at time zone 'UTC', ${TS}) as created_at
        from app.tax_return where company_id = ${c}::uuid order by period_start, id`,
  ),
  // The authority's raw `response`, the request digest and the worker's claim/poll clocks stay behind: they are
  // transmission plumbing, and the outcome a tenant keeps is the status, the external id and the QR payload.
  t(
    "einvoice_transmission",
    "accounting.tax.file",
    "company",
    [
      "id",
      "document_id",
      "transmitter",
      "profile_version",
      "external_id",
      "status",
      "attempts",
      "last_error",
      "qr_payload",
      "submitted_at",
      "accepted_at",
      "cancelled_at",
      "created_at",
    ],
    (tx, c) =>
      tx<
        ExportRow[]
      >`select id, document_id, transmitter, profile_version, external_id, status, attempts,
        last_error, qr_payload, to_char(submitted_at at time zone 'UTC', ${TS}) as submitted_at,
        to_char(accepted_at at time zone 'UTC', ${TS}) as accepted_at,
        to_char(cancelled_at at time zone 'UTC', ${TS}) as cancelled_at,
        to_char(created_at at time zone 'UTC', ${TS}) as created_at
        from app.einvoice_transmission where company_id = ${c}::uuid order by created_at, id`,
  ),

  // ── HR and the till's staff — gated hr.employee.read (6C) ────────────────────────────────────────────
  t(
    "employee",
    "hr.employee.read",
    "company",
    [
      "id",
      "party_id",
      "employee_number",
      "home_branch_id",
      "principal_id",
      "hired_on",
      "terminated_on",
      // 8A Task 14: migration 0080's position, employment type and archive stamp leave with the master they
      // describe. `statutory_profile_note` stays behind (schema.json lists it `omitted`): no route reads or
      // writes it, and statutory handling is the compensation-gated profile's subject, not the directory's.
      "position",
      "employment_type",
      "archived_at",
      // 8D's 0098 (contracts round 19, 8D A2): an operational date of the same class as hired_on, so it leaves too.
      "contract_ends_on",
      // 9B's 0101 (contracts §4.13.3): the source system's own identifier is part of the books (SAH-051).
      "legacy_ref",
      "created_at",
    ],
    (tx, c) =>
      tx<ExportRow[]>`select id, party_id, employee_number, home_branch_id, principal_id,
        to_char(hired_on, ${DAY}) as hired_on, to_char(terminated_on, ${DAY}) as terminated_on,
        position, employment_type, to_char(archived_at at time zone 'UTC', ${TS}) as archived_at,
        to_char(contract_ends_on, ${DAY}) as contract_ends_on, legacy_ref,
        to_char(created_at at time zone 'UTC', ${TS}) as created_at
        from app.employee where company_id = ${c}::uuid order by employee_number, id`,
  ),
  t(
    "attendance_event",
    "hr.employee.read",
    "company",
    [
      "id",
      "employee_id",
      "branch_id",
      "kind",
      "occurred_at",
      "terminal_id",
      "recorded_by",
      "note",
      "corrects_event_id",
      "created_at",
    ],
    (tx, c) =>
      tx<ExportRow[]>`select id, employee_id, branch_id, kind,
        to_char(occurred_at at time zone 'UTC', ${TS}) as occurred_at, terminal_id, recorded_by, note,
        corrects_event_id, to_char(created_at at time zone 'UTC', ${TS}) as created_at
        from app.attendance_event where company_id = ${c}::uuid order by occurred_at, id`,
  ),
  t(
    "pos_cashier",
    "hr.employee.read",
    "company",
    ["principal_id", "employee_id", "branch_id", "pin_updated_at", "revoked_at", "created_at"],
    (tx, c) =>
      tx<ExportRow[]>`select principal_id, employee_id, branch_id,
        to_char(pin_updated_at at time zone 'UTC', ${TS}) as pin_updated_at,
        to_char(revoked_at at time zone 'UTC', ${TS}) as revoked_at,
        to_char(created_at at time zone 'UTC', ${TS}) as created_at
        from app.pos_cashier where company_id = ${c}::uuid order by principal_id`,
  ),
  // 8A T11 (⚠️ OD-23): the company's proration rule and pay day — configuration, not a confidential record, so it
  // leaves ungated like `company` itself. The employer registrations are not here (amendment A4): they are
  // columns of `statutory_scheme`.
  t(
    "company_hr_setting",
    null,
    "company",
    ["id", "company_id", "proration_rule", "pay_day", "created_at"],
    (tx, c) =>
      tx<ExportRow[]>`select id, company_id, proration_rule, pay_day,
        to_char(created_at at time zone 'UTC', ${TS}) as created_at
        from app.company_hr_setting where company_id = ${c}::uuid order by id`,
  ),

  // ── HR (8A Task 14, contracts round 16 A20) — every row gated, and the ciphertext never leaves ────────
  // None of the three employee sub-records carries a company_id of its own (that is why sensitive_gate joins
  // app.employee, spec:2076), so each query joins app.employee for the company bound.
  t(
    "employee_sensitive",
    "hr.employee.read_sensitive",
    "company",
    ["employee_id", "key_version", "updated_by", "updated_at", "created_at"],
    (tx, c) =>
      tx<ExportRow[]>`select es.employee_id, es.key_version, es.updated_by,
        to_char(es.updated_at at time zone 'UTC', ${TS}) as updated_at,
        to_char(es.created_at at time zone 'UTC', ${TS}) as created_at
        from app.employee_sensitive es join app.employee e on e.id = es.employee_id
        where e.company_id = ${c}::uuid order by es.employee_id`,
  ),
  t(
    "employee_statutory_profile",
    "hr.compensation.read",
    "company",
    [
      "id",
      "employee_id",
      "effective_from",
      "effective_to",
      "marital_status",
      "spouse_working",
      "child_relief_count",
      "residency_category",
      "extra",
      "entered_by",
      "created_at",
    ],
    (tx, c) =>
      tx<
        ExportRow[]
      >`select p.id, p.employee_id, to_char(p.effective_from, ${DAY}) as effective_from,
        to_char(p.effective_to, ${DAY}) as effective_to, p.marital_status, p.spouse_working,
        p.child_relief_count, p.residency_category, p.extra::text as extra, p.entered_by,
        to_char(p.created_at at time zone 'UTC', ${TS}) as created_at
        from app.employee_statutory_profile p join app.employee e on e.id = p.employee_id
        where e.company_id = ${c}::uuid order by p.employee_id, p.effective_from`,
  ),
  // The catalogue names what a company pays for; its list route is gated on the compensation read code
  // (spec:2159 keeps it from `user`), and so is its export, the join included.
  t(
    "pay_component",
    "hr.compensation.read",
    "company",
    [
      "id",
      "code",
      "name_en",
      "name_ar",
      "kind",
      "expense_account_id",
      "payable_account_id",
      "quantity_based",
      "archived_at",
      "created_at",
    ],
    (tx, c) =>
      tx<
        ExportRow[]
      >`select id, code, name_en, name_ar, kind, expense_account_id, payable_account_id,
        quantity_based, to_char(archived_at at time zone 'UTC', ${TS}) as archived_at,
        to_char(created_at at time zone 'UTC', ${TS}) as created_at
        from app.pay_component where company_id = ${c}::uuid order by code, id`,
  ),
  t(
    "pay_component_scheme",
    "hr.compensation.read",
    "company",
    ["component_id", "scheme_id"],
    (tx, c) =>
      tx<ExportRow[]>`select j.component_id, j.scheme_id
        from app.pay_component_scheme j join app.pay_component pc on pc.id = j.component_id
        where pc.company_id = ${c}::uuid order by j.component_id, j.scheme_id`,
  ),
  t(
    "compensation_line",
    "hr.compensation.read",
    "company",
    [
      "id",
      "employee_id",
      "component_id",
      "effective_from",
      "effective_to",
      "amount",
      "quantity",
      "entered_by",
      "created_at",
    ],
    (tx, c) =>
      tx<ExportRow[]>`select cl.id, cl.employee_id, cl.component_id,
        to_char(cl.effective_from, ${DAY}) as effective_from, to_char(cl.effective_to, ${DAY}) as effective_to,
        cl.amount::text as amount, cl.quantity::text as quantity, cl.entered_by,
        to_char(cl.created_at at time zone 'UTC', ${TS}) as created_at
        from app.compensation_line cl join app.employee e on e.id = cl.employee_id
        where e.company_id = ${c}::uuid order by cl.employee_id, cl.component_id, cl.effective_from`,
  ),
  // Schemes and their versioned rate tables are read under either statutory-table code; a registry gate is one
  // code, so both rows take the MANAGE code — the payroll officer who keeps the tables (hr_payroll), the role
  // that owns this data. A verify-only accountant's export names both as excluded.
  t(
    "statutory_scheme",
    "hr.statutory_table.manage",
    "company",
    [
      "id",
      "code",
      "name_en",
      "name_ar",
      "payable_account_id",
      "employer_expense_account_id",
      "authority_party_id",
      "employer_registration",
      "rounding_mode",
      "created_at",
    ],
    (tx, c) =>
      tx<
        ExportRow[]
      >`select id, code, name_en, name_ar, payable_account_id, employer_expense_account_id,
        authority_party_id, employer_registration, rounding_mode,
        to_char(created_at at time zone 'UTC', ${TS}) as created_at
        from app.statutory_scheme where company_id = ${c}::uuid order by code, id`,
  ),
  t(
    "statutory_rate_table",
    "hr.statutory_table.manage",
    "company",
    [
      "id",
      "scheme_id",
      "version",
      "effective_from",
      "effective_to",
      "definition",
      "source",
      "loaded_by",
      "verified_by",
      "verified_at",
      "created_at",
    ],
    (tx, c) =>
      tx<
        ExportRow[]
      >`select t.id, t.scheme_id, t.version, to_char(t.effective_from, ${DAY}) as effective_from,
        to_char(t.effective_to, ${DAY}) as effective_to, t.definition::text as definition, t.source,
        t.loaded_by, t.verified_by, to_char(t.verified_at at time zone 'UTC', ${TS}) as verified_at,
        to_char(t.created_at at time zone 'UTC', ${TS}) as created_at
        from app.statutory_rate_table t join app.statutory_scheme sc on sc.id = t.scheme_id
        where sc.company_id = ${c}::uuid order by sc.code, t.version`,
  ),
  // 8B (migration 0087) — the payroll run's two extension tables, gated on the payroll read code (§4.12.6:
  // "Read gate: hr.payroll.read"). Every row of every state leaves, drafts included, as `document` does; the
  // figures are the run's and are what a payslip and a statutory schedule are generated from.
  t(
    "payroll_run",
    "hr.payroll.read",
    "company",
    [
      "document_id",
      "kind",
      "period_start",
      "period_end",
      "pay_date",
      "pinned_tables",
      "calculated_at",
      "calculated_by",
      "created_at",
    ],
    (tx, c) =>
      tx<ExportRow[]>`select document_id, kind, to_char(period_start, ${DAY}) as period_start,
        to_char(period_end, ${DAY}) as period_end, to_char(pay_date, ${DAY}) as pay_date,
        pinned_tables::text as pinned_tables,
        to_char(calculated_at at time zone 'UTC', ${TS}) as calculated_at, calculated_by,
        to_char(created_at at time zone 'UTC', ${TS}) as created_at
        from app.payroll_run where company_id = ${c}::uuid order by period_start, document_id`,
  ),
  t(
    "payroll_line",
    "hr.payroll.read",
    "company",
    [
      "document_line_id",
      "employee_id",
      "component_id",
      "scheme_id",
      "share",
      "quantity",
      "amount",
      "rate_table_id",
      "rate_table_version",
      "override_reason",
      "entered_by",
      "created_at",
    ],
    (tx, c) =>
      tx<ExportRow[]>`select document_line_id, employee_id, component_id, scheme_id, share,
        quantity::text as quantity, amount::text as amount, rate_table_id, rate_table_version,
        override_reason, entered_by, to_char(created_at at time zone 'UTC', ${TS}) as created_at
        from app.payroll_line where company_id = ${c}::uuid order by document_line_id`,
  ),
  // 8C (migration 0091) — the statutory schedule: per-scheme totals of a posted run, gated as the run is.
  t(
    "statutory_schedule",
    "hr.payroll.read",
    "company",
    [
      "id",
      "scheme_id",
      "period_start",
      "period_end",
      "payroll_document_id",
      "total_employee",
      "total_employer",
      "currency",
      "attachment_id",
      "remittance_document_id",
      "generated_by",
      "created_at",
    ],
    (tx, c) =>
      tx<ExportRow[]>`select id, scheme_id, to_char(period_start, ${DAY}) as period_start,
        to_char(period_end, ${DAY}) as period_end, payroll_document_id,
        total_employee::text as total_employee, total_employer::text as total_employer, currency,
        attachment_id, remittance_document_id, generated_by,
        to_char(created_at at time zone 'UTC', ${TS}) as created_at
        from app.statutory_schedule where company_id = ${c}::uuid order by period_start, scheme_id, id`,
  ),
  // 8C (migration 0092) — the YTD projection and its cut-over openings, per-employee pay figures gated as the run.
  t(
    "employee_ytd",
    "hr.payroll.read",
    "company",
    [
      "employee_id",
      "tax_year",
      "gross",
      "net",
      "by_component",
      "by_scheme",
      "created_at",
      "updated_at",
    ],
    (tx, c) =>
      tx<ExportRow[]>`select employee_id, tax_year, gross::text as gross, net::text as net,
        by_component::text as by_component, by_scheme::text as by_scheme,
        to_char(created_at at time zone 'UTC', ${TS}) as created_at,
        to_char(updated_at at time zone 'UTC', ${TS}) as updated_at
        from app.employee_ytd where company_id = ${c}::uuid order by employee_id, tax_year`,
  ),
  t(
    "employee_ytd_opening",
    "hr.payroll.read",
    "company",
    [
      "id",
      "employee_id",
      "tax_year",
      "gross",
      "net",
      "by_component",
      "by_scheme",
      "source",
      "loaded_by",
      "created_at",
    ],
    (tx, c) =>
      tx<ExportRow[]>`select id, employee_id, tax_year, gross::text as gross, net::text as net,
        by_component::text as by_component, by_scheme::text as by_scheme, source, loaded_by,
        to_char(created_at at time zone 'UTC', ${TS}) as created_at
        from app.employee_ytd_opening where company_id = ${c}::uuid order by employee_id, tax_year, id`,
  ),
  // 8D Task 8 (⚠️ OD-13 answered build, migration 0096) — the leave register. The vocabulary and the holiday calendar
  // are company configuration and leave ungated, as `company_hr_setting` does; the per-employee entitlements and
  // records leave under `hr.employee.read`, the register's own read code (its route and its dataset's gate).
  t(
    "leave_type",
    null,
    "company",
    ["id", "company_id", "code", "name_en", "name_ar", "paid", "archived_at", "created_at"],
    (tx, c) =>
      tx<ExportRow[]>`select id, company_id, code, name_en, name_ar, paid,
        to_char(archived_at at time zone 'UTC', ${TS}) as archived_at,
        to_char(created_at at time zone 'UTC', ${TS}) as created_at
        from app.leave_type where company_id = ${c}::uuid order by code, id`,
  ),
  t(
    "leave_entitlement",
    "hr.employee.read",
    "company",
    ["id", "employee_id", "year", "leave_type_id", "days", "entered_by", "created_at"],
    (tx, c) =>
      tx<ExportRow[]>`select id, employee_id, year, leave_type_id, days::text as days, entered_by,
        to_char(created_at at time zone 'UTC', ${TS}) as created_at
        from app.leave_entitlement where company_id = ${c}::uuid order by employee_id, year, leave_type_id, id`,
  ),
  t(
    "leave_record",
    "hr.employee.read",
    "company",
    [
      "id",
      "employee_id",
      "leave_type_id",
      "starts_on",
      "ends_on",
      "days",
      "status",
      "approved_by",
      "reason",
      "created_at",
    ],
    (tx, c) =>
      tx<
        ExportRow[]
      >`select id, employee_id, leave_type_id, to_char(starts_on, ${DAY}) as starts_on,
        to_char(ends_on, ${DAY}) as ends_on, days::text as days, status, approved_by, reason,
        to_char(created_at at time zone 'UTC', ${TS}) as created_at
        from app.leave_record where company_id = ${c}::uuid order by starts_on, employee_id, id`,
  ),
  t(
    "public_holiday",
    null,
    "company",
    ["id", "company_id", "branch_id", "holiday_on", "name_en", "name_ar", "created_at"],
    (tx, c) =>
      tx<ExportRow[]>`select id, company_id, branch_id, to_char(holiday_on, ${DAY}) as holiday_on,
        name_en, name_ar, to_char(created_at at time zone 'UTC', ${TS}) as created_at
        from app.public_holiday where company_id = ${c}::uuid order by holiday_on, branch_id nulls first, id`,
  ),

  // ── POS — configuration ungated, the till's records gated as 6D's reports are ────────────────────────
  t(
    "pos_terminal",
    null,
    "company",
    [
      "id",
      "branch_id",
      "principal_id",
      "name",
      "code",
      "enrolled_by",
      "enrolled_at",
      "revoked_at",
      "created_at",
    ],
    (tx, c) =>
      tx<ExportRow[]>`select id, branch_id, principal_id, name, code, enrolled_by,
        to_char(enrolled_at at time zone 'UTC', ${TS}) as enrolled_at,
        to_char(revoked_at at time zone 'UTC', ${TS}) as revoked_at,
        to_char(created_at at time zone 'UTC', ${TS}) as created_at
        from app.pos_terminal where company_id = ${c}::uuid order by code, id`,
  ),
  t(
    "branch_pos_policy",
    null,
    "company",
    [
      "id",
      "branch_id",
      "max_line_discount_pct",
      "max_ticket_discount_pct",
      "max_void_amount",
      "max_price_override_pct",
      "blind_return_allowed",
      "max_blind_return_amount",
      "max_cash_in_drawer",
      "require_customer_over",
      "rounding_increment",
      "paid_out_allowed",
      "max_paid_out_amount",
      "created_at",
    ],
    (tx, c) =>
      tx<ExportRow[]>`select id, branch_id, max_line_discount_pct::text as max_line_discount_pct,
        max_ticket_discount_pct::text as max_ticket_discount_pct, max_void_amount::text as max_void_amount,
        max_price_override_pct::text as max_price_override_pct, blind_return_allowed,
        max_blind_return_amount::text as max_blind_return_amount,
        max_cash_in_drawer::text as max_cash_in_drawer, require_customer_over::text as require_customer_over,
        rounding_increment::text as rounding_increment, paid_out_allowed,
        max_paid_out_amount::text as max_paid_out_amount,
        to_char(created_at at time zone 'UTC', ${TS}) as created_at
        from app.branch_pos_policy where company_id = ${c}::uuid order by branch_id, id`,
  ),
  t(
    "shift",
    "pos.report.read",
    "company",
    [
      "id",
      "branch_id",
      "terminal_id",
      "opened_principal_id",
      "opened_at",
      "opening_float",
      "currency",
      "closed_at",
      "closed_principal_id",
      "counted_cash",
      "expected_cash",
      "over_short",
      "over_short_document_id",
      "created_at",
    ],
    (tx, c) =>
      tx<ExportRow[]>`select id, branch_id, terminal_id, opened_principal_id,
        to_char(opened_at at time zone 'UTC', ${TS}) as opened_at, opening_float::text as opening_float,
        currency, to_char(closed_at at time zone 'UTC', ${TS}) as closed_at, closed_principal_id,
        counted_cash::text as counted_cash, expected_cash::text as expected_cash,
        over_short::text as over_short, over_short_document_id,
        to_char(created_at at time zone 'UTC', ${TS}) as created_at
        from app.shift where company_id = ${c}::uuid order by opened_at, id`,
  ),
  // No `client_ref`: the till's own uuid is an idempotency key, not a reporting fact (7C A1).
  t(
    "till_event",
    "pos.report.read",
    "company",
    [
      "id",
      "shift_id",
      "branch_id",
      "terminal_id",
      "kind",
      "ticket_document_id",
      "cashier_principal_id",
      "supervisor_principal_id",
      "occurred_at",
      "reason",
      "created_at",
    ],
    (tx, c) =>
      tx<ExportRow[]>`select id, shift_id, branch_id, terminal_id, kind, ticket_document_id,
        cashier_principal_id, supervisor_principal_id,
        to_char(occurred_at at time zone 'UTC', ${TS}) as occurred_at, reason,
        to_char(created_at at time zone 'UTC', ${TS}) as created_at
        from app.till_event where company_id = ${c}::uuid order by occurred_at, id`,
  ),
  t(
    "till_banking_link",
    "pos.report.read",
    "company",
    [
      "id",
      "branch_id",
      "banking_document_id",
      "shift_id",
      "bank_account_id",
      "from_safe",
      "value_date",
      "amount",
      "currency",
      "reference",
      "created_at",
    ],
    (tx, c) =>
      tx<
        ExportRow[]
      >`select id, branch_id, banking_document_id, shift_id, bank_account_id, from_safe,
        to_char(value_date, ${DAY}) as value_date, amount::text as amount, currency, reference,
        to_char(created_at at time zone 'UTC', ${TS}) as created_at
        from app.till_banking_link where company_id = ${c}::uuid order by value_date, id`,
  ),
  t(
    "needs_attention",
    "pos.needs_attention.resolve",
    "company",
    [
      "id",
      "branch_id",
      "terminal_id",
      "client_ref",
      "error_code",
      "error_detail",
      "resolved_by",
      "resolved_at",
      "resolution_note",
      "created_at",
    ],
    (tx, c) =>
      tx<
        ExportRow[]
      >`select id, branch_id, terminal_id, client_ref, error_code, error_detail, resolved_by,
        to_char(resolved_at at time zone 'UTC', ${TS}) as resolved_at, resolution_note,
        to_char(created_at at time zone 'UTC', ${TS}) as created_at
        from app.needs_attention where company_id = ${c}::uuid order by created_at, id`,
  ),

  // ── reporting and attachments (metadata; the bytes are the archive's attachments/ directory) ─────────
  t(
    "report_definition",
    null,
    "company",
    ["id", "code", "version", "definition", "cloned_from", "is_core", "archived_at", "created_at"],
    (tx, c) =>
      tx<
        ExportRow[]
      >`select id, code, version, definition::text as definition, cloned_from, is_core,
        to_char(archived_at at time zone 'UTC', ${TS}) as archived_at,
        to_char(created_at at time zone 'UTC', ${TS}) as created_at
        from app.report_definition where company_id = ${c}::uuid order by code, version, id`,
  ),
  t(
    "saved_view",
    null,
    "company",
    [
      "id",
      "report_definition_id",
      "name_en",
      "name_ar",
      "parameters",
      "owner_principal_id",
      "shared",
      "archived_at",
      "created_at",
    ],
    (tx, c) =>
      tx<
        ExportRow[]
      >`select id, report_definition_id, name_en, name_ar, parameters::text as parameters,
        owner_principal_id, shared, to_char(archived_at at time zone 'UTC', ${TS}) as archived_at,
        to_char(created_at at time zone 'UTC', ${TS}) as created_at
        from app.saved_view where company_id = ${c}::uuid order by created_at, id`,
  ),
  // Who ran which report, when and with what parameters (ADR 0067) — an ACTIVITY record, so it is audit
  // information and is gated on the auditor's code (second review, finding 3). It is NOT gated as the runs list
  // is: the list shows a run only to a holder of its definition's own read code (`listReportRuns`), and an
  // export gated on `accounting.report.export` alone handed every run in the company — `accounting.audit_log`'s
  // and the cost reports' parameters and requesters included — to anyone holding that one code. The object key
  // and the lease columns stay behind (pinned above).
  t(
    "report_run",
    "admin.audit_log.read",
    "company",
    [
      "id",
      "report_definition_id",
      "saved_view_id",
      "parameters",
      "format",
      "lang",
      "status",
      "requested_by",
      "sha256",
      "finished_at",
      "error",
      "created_at",
    ],
    (tx, c) =>
      tx<
        ExportRow[]
      >`select id, report_definition_id, saved_view_id, parameters::text as parameters, format,
        lang, status, requested_by, encode(sha256, 'hex') as sha256,
        to_char(finished_at at time zone 'UTC', ${TS}) as finished_at, error,
        to_char(created_at at time zone 'UTC', ${TS}) as created_at
        from app.report_run where company_id = ${c}::uuid order by created_at, id`,
  ),
  t(
    "attachment",
    null,
    "company",
    [
      "id",
      "document_id",
      "lot_id",
      "file_name",
      "mime_type",
      "byte_size",
      "sha256",
      "uploaded_by",
      "archived_at",
      "created_at",
    ],
    (tx, c, scope) =>
      tx<ExportRow[]>`select id, document_id, lot_id, file_name, mime_type,
        byte_size::text as byte_size, encode(sha256, 'hex') as sha256, uploaded_by,
        to_char(archived_at at time zone 'UTC', ${TS}) as archived_at,
        to_char(created_at at time zone 'UTC', ${TS}) as created_at
        from app.attachment where company_id = ${c}::uuid
          and (document_id is null or document_id not in (${hiddenDocuments(tx, scope)}))
        order by created_at, id`,
  ),

  // ── the audit trail — gated, tenant-wide, and without its row images (NEVER_EXPORTED) ────────────────
  // `app.audit_log` has no company_id; it is the auditor's view of the whole tenant, as 7A's `audit_log`
  // dataset declares `company: null` (spec:2163). The chain hashes stay behind with the images they hash.
  t(
    "audit_log",
    "admin.audit_log.read",
    "tenant",
    ["seq", "occurred_at", "table_name", "row_id", "action", "actor_id"],
    (tx) =>
      tx<
        ExportRow[]
      >`select seq::text as seq, to_char(occurred_at at time zone 'UTC', ${TS}) as occurred_at,
        table_name, row_id, action, actor_id
        from app.audit_log order by audit_log.seq`,
  ),
];

const BY_NAME = new Map(EXPORT_TABLES.map((table) => [table.name, table]));

export function exportTable(name: string): ExportTable {
  const found = BY_NAME.get(name);
  if (!found)
    throw new Error(`export table '${name}' is not registered (packages/db/src/export/tables.ts)`);
  return found;
}

/**
 * Resolves every gate for one principal in one company through `app.principal_has` (2B, §4.5.3) — the same
 * predicate the override guard uses, so "may this person see this" has one answer in the system. An ungated
 * table is always included; a gated table the principal does not hold is excluded AND NAMED, so the archive's
 * manifest says what is missing and why rather than silently shrinking. The branch argument is null: a
 * branch-narrowed assignment holds no company-wide gate, exactly as the route's own gate (test 36).
 */
export async function resolveExportGates(
  tx: Sql,
  input: { principalId: string; companyId: string },
): Promise<{
  included: readonly ExportTable[];
  excluded: readonly { table: string; gate: string }[];
  /** The rows of an INCLUDED `moduleRows` table kept out, per hidden module, with the gate that would admit them —
   *  `manifest.excludedRows`, so an export missing the payroll documents says so (Phase 8 review). */
  excludedRows: readonly { table: string; gate: string; module: string }[];
  scope: ExportRowScope;
}> {
  const gates = [
    ...new Set([
      ...EXPORT_TABLES.flatMap((table) => (table.gate === null ? [] : [table.gate])),
      ...Object.values(MODULE_ROW_GATES),
    ]),
  ].toSorted();
  const answers = await tx<{ gate: string; held: boolean }[]>`
    select g.gate, app.principal_has(${input.principalId}::uuid, g.gate, ${input.companyId}::uuid, null) as held
      from unnest(${gates}::text[]) as g(gate)`;
  const held = new Set(answers.filter((answer) => answer.held).map((answer) => answer.gate));
  const included: ExportTable[] = [];
  const excluded: { table: string; gate: string }[] = [];
  for (const table of EXPORT_TABLES) {
    if (table.gate === null || held.has(table.gate)) included.push(table);
    else excluded.push({ table: table.name, gate: table.gate });
  }
  const hidden = Object.entries(MODULE_ROW_GATES)
    .filter(([, gate]) => !held.has(gate))
    .toSorted(([a], [b]) => a.localeCompare(b));
  const excludedRows = included
    .filter((table) => table.moduleRows)
    .flatMap((table) => hidden.map(([module, gate]) => ({ table: table.name, gate, module })));
  return {
    included,
    excluded,
    excludedRows,
    scope: { hiddenModules: hidden.map(([module]) => module) },
  };
}

/**
 * The audit log's row-image rule (ADR 0090; review findings DBS-01, API-02, HRP-01). `app.audit_log` copies
 * every audited row whole into `before`/`after`, so its images would defeat every gate this registry and the
 * RESTRICTIVE policies keep — the export already pins them out (`NEVER_EXPORTED.audit_log`). `GET
 * /v1/admin/audit-log` serves an image only under the rule THIS registry states for its table, so one table map
 * decides both what an export carries and what an audit reader sees:
 *  - `gate`: the table's own export gate, asked in the audited row's company (`null` = `admin.audit_log.read`
 *    alone suffices);
 *  - `columns`: the image is projected onto the table's registered export columns, so a column not named there
 *    (a credential hash, an object key, a ciphertext) does not leave through the audit trail either; `null` only
 *    for a system event, whose payload is served whole.
 * A table with no rule — pinned whole in `NEVER_EXPORTED`, or a name nothing registers — never has its images
 * served. A row whose document belongs to a module in `MODULE_ROW_GATES` additionally needs that module's code.
 */
export interface AuditImageRule {
  readonly gate: string | null;
  readonly columns: readonly string[] | null;
}

/**
 * The names `app.record_system_event` (0105, 0111, 0120, 0121) and `app.record_cashier_snapshot_drift` (0067)
 * write to `audit_log.table_name`. They are events, not tables: each states the gate its payload's facts sit
 * behind, or borrows the whole rule of the table its images are copies of.
 */
export const AUDIT_SYSTEM_EVENTS: Readonly<
  Record<string, { readonly gate: string | null } | { readonly borrows: string }>
> = {
  integrity_incident: { gate: null },
  month_end_ready: { gate: null },
  lot_expiry_warning: { gate: "inventory.stock.read" },
  rate_table_lapse_warning: { borrows: "statutory_rate_table" },
  employee_ytd_drift: { gate: "hr.payroll.read" },
  // its before/after are `pos_cashier` snapshots: that table's gate and columns, so never the PIN hash.
  cashier_snapshot_drift: { borrows: "pos_cashier" },
};

/** Every name an image may be served for, with its rule — built once from `EXPORT_TABLES`, `NEVER_EXPORTED` and
 *  `AUDIT_SYSTEM_EVENTS`. A name absent here has its images withheld. */
export const AUDIT_IMAGE_RULES: ReadonlyMap<string, AuditImageRule> = (() => {
  const rules = new Map<string, AuditImageRule>();
  for (const table of EXPORT_TABLES) {
    const pinned = new Set(NEVER_EXPORTED[table.name] ?? []);
    if (pinned.has("*")) continue;
    rules.set(table.name, {
      gate: table.gate,
      columns: table.columns.filter((column) => !pinned.has(column)),
    });
  }
  for (const [name, event] of Object.entries(AUDIT_SYSTEM_EVENTS)) {
    const rule =
      "borrows" in event ? rules.get(event.borrows) : { gate: event.gate, columns: null };
    if (rule === undefined)
      throw new Error(`AUDIT_SYSTEM_EVENTS.${name} borrows an unregistered table`);
    rules.set(name, rule);
  }
  return rules;
})();

/** One image as an audit reader may see it: projected onto its rule's columns, or `null` with no rule. */
export function projectAuditImage(tableName: string, image: unknown): unknown {
  if (image === null || image === undefined) return null;
  const rule = AUDIT_IMAGE_RULES.get(tableName);
  if (rule === undefined) return null;
  if (rule.columns === null) return image;
  if (typeof image !== "object" || Array.isArray(image)) return null;
  const source = image as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const column of rule.columns)
    if (Object.hasOwn(source, column)) out[column] = source[column];
  return out;
}
