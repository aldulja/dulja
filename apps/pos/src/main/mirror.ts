// apps/pos/src/main/mirror.ts
import type { Stream } from "@dulja/sync";
import type { PosDatabase } from "./database";
import { revisionToText } from "./money";
import { pinAttemptKey } from "./authority";

export interface MirrorRow {
  id: string;
  revision: bigint;
  row: Record<string, unknown>;
}

/** `Stream` -> table, total and mechanical (A8a). `CATALOGUE_STREAMS` is the list; this is the mapping. */
export const MIRROR_TABLE: Readonly<Record<Stream, string>> = {
  item: "catalogue_item",
  price_list: "catalogue_price_list",
  price_list_line: "catalogue_price_list_line",
  promotion: "catalogue_promotion",
  customer: "catalogue_customer",
  tax_code: "catalogue_tax_code",
  cashier: "catalogue_cashier",
  branch_pos_policy: "catalogue_branch_pos_policy",
};

/** Reads a server column out of `to_jsonb(row) - 'tenant_id'` (6A's `readCatalogue`). A missing NOT NULL
 *  column is a protocol disagreement and must throw here, at the row that carries it, rather than surface
 *  four screens later as a null price. */
function need(row: Record<string, unknown>, key: string, stream: Stream, id: string): string {
  const v = row[key];
  if (typeof v !== "string" || v.length === 0)
    throw new TypeError(`${stream}/${id}: the server row has no string ${key}`);
  return v;
}
function opt(row: Record<string, unknown>, key: string): string | null {
  const v = row[key];
  if (v === null || v === undefined) return null;
  if (typeof v !== "string") throw new TypeError(`server column ${key} must be a string`);
  return v;
}
function bool(row: Record<string, unknown>, key: string): number {
  const value = row[key];
  if (typeof value !== "boolean") throw new TypeError(`server column ${key} must be a boolean`);
  return value ? 1 : 0;
}

/**
 * The eight upsert writers. Each extracts only the columns a lookup indexes and keeps the whole server row
 * in `row_json`; nothing else reads a mirror's extracted column as a source of truth, so adding a column
 * later is an index change and never a data migration.
 *
 * There is one statement per stream and no dynamic table name: `MIRROR_TABLE[stream]` selects a **literal**
 * SQL string below, never interpolates one — spec:100's "never build SQL by string concatenation" binds the
 * till as much as the server (LEGACY-036/037/069), and acceptance test 27 is the mechanical check.
 */
export function upsertMirror(db: PosDatabase, stream: Stream, m: MirrorRow): void {
  const identity = stream === "cashier" ? m.row["principal_id"] : m.row["id"];
  if (identity !== m.id) throw new TypeError("catalogue row id disagrees with change id");
  if (
    stream === "cashier" &&
    (typeof m.row["snapshot"] !== "object" ||
      m.row["snapshot"] === null ||
      Array.isArray(m.row["snapshot"]))
  )
    throw new TypeError("cashier snapshot must be an object");
  const rev = revisionToText(m.revision);
  const json = JSON.stringify(m.row);
  switch (stream) {
    case "item":
      db.raw
        .prepare(
          `insert into catalogue_item (id, revision, row_json, code, barcode, name_en, name_ar, kind, base_unit_id, track_lots)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         on conflict (id) do update set revision = excluded.revision, row_json = excluded.row_json,
           code = excluded.code, barcode = excluded.barcode, name_en = excluded.name_en,
           name_ar = excluded.name_ar, kind = excluded.kind, base_unit_id = excluded.base_unit_id,
           track_lots = excluded.track_lots`,
        )
        .run(
          m.id,
          rev,
          json,
          need(m.row, "code", stream, m.id),
          opt(m.row, "barcode"),
          need(m.row, "name_en", stream, m.id),
          opt(m.row, "name_ar"),
          need(m.row, "kind", stream, m.id),
          need(m.row, "base_unit_id", stream, m.id),
          bool(m.row, "track_lots"),
        );
      return;
    case "price_list":
      db.raw
        .prepare(
          `insert into catalogue_price_list (id, revision, row_json, code, currency, customer_kind, branch_id, valid_from, valid_to)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?)
         on conflict (id) do update set revision = excluded.revision, row_json = excluded.row_json,
           code = excluded.code, currency = excluded.currency, customer_kind = excluded.customer_kind,
           branch_id = excluded.branch_id, valid_from = excluded.valid_from, valid_to = excluded.valid_to`,
        )
        .run(
          m.id,
          rev,
          json,
          need(m.row, "code", stream, m.id),
          need(m.row, "currency", stream, m.id),
          opt(m.row, "customer_kind"),
          opt(m.row, "branch_id"),
          opt(m.row, "valid_from"),
          opt(m.row, "valid_to"),
        );
      return;
    case "price_list_line":
      db.raw
        .prepare(
          `insert into catalogue_price_list_line (id, revision, row_json, price_list_id, item_id, unit_id, min_quantity, unit_price)
         values (?, ?, ?, ?, ?, ?, ?, ?)
         on conflict (id) do update set revision = excluded.revision, row_json = excluded.row_json,
           price_list_id = excluded.price_list_id, item_id = excluded.item_id, unit_id = excluded.unit_id,
           min_quantity = excluded.min_quantity, unit_price = excluded.unit_price`,
        )
        .run(
          m.id,
          rev,
          json,
          need(m.row, "price_list_id", stream, m.id),
          need(m.row, "item_id", stream, m.id),
          opt(m.row, "unit_id"),
          need(m.row, "min_quantity", stream, m.id),
          need(m.row, "unit_price", stream, m.id),
        );
      return;
    case "promotion":
      db.raw
        .prepare(
          `insert into catalogue_promotion (id, revision, row_json, code, kind, definition, starts_at, ends_at, branch_id)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?)
         on conflict (id) do update set revision = excluded.revision, row_json = excluded.row_json,
           code = excluded.code, kind = excluded.kind, definition = excluded.definition,
           starts_at = excluded.starts_at, ends_at = excluded.ends_at, branch_id = excluded.branch_id`,
        )
        .run(
          m.id,
          rev,
          json,
          need(m.row, "code", stream, m.id),
          need(m.row, "kind", stream, m.id),
          JSON.stringify(m.row["definition"] ?? {}),
          opt(m.row, "starts_at"),
          opt(m.row, "ends_at"),
          opt(m.row, "branch_id"),
        );
      return;
    case "customer":
      db.raw
        .prepare(
          `insert into catalogue_customer (id, revision, row_json, code, name_en, name_ar, phone, currency, credit_limit, credit_hold)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         on conflict (id) do update set revision = excluded.revision, row_json = excluded.row_json,
           code = excluded.code, name_en = excluded.name_en, name_ar = excluded.name_ar, phone = excluded.phone,
           currency = excluded.currency, credit_limit = excluded.credit_limit, credit_hold = excluded.credit_hold`,
        )
        .run(
          m.id,
          rev,
          json,
          need(m.row, "code", stream, m.id),
          need(m.row, "name_en", stream, m.id),
          opt(m.row, "name_ar"),
          opt(m.row, "phone"),
          opt(m.row, "currency"),
          opt(m.row, "credit_limit"),
          bool(m.row, "credit_hold"),
        );
      return;
    case "tax_code":
      db.raw
        .prepare(
          // `archived_at` is extracted, not left in row_json: T5's `defaultOutputTaxCode` filters on it, and a
          // superseded output code whose effective window still contains today would otherwise make the
          // "exactly one open output code" test count 2 and answer `null` (5A:591, spec:2049).
          `insert into catalogue_tax_code (id, revision, row_json, code, rate, kind, rounding_mode, output_account_id, input_account_id, effective_from, effective_to, archived_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         on conflict (id) do update set revision = excluded.revision, row_json = excluded.row_json,
           code = excluded.code, rate = excluded.rate, kind = excluded.kind, rounding_mode = excluded.rounding_mode,
           output_account_id = excluded.output_account_id, input_account_id = excluded.input_account_id,
           effective_from = excluded.effective_from, effective_to = excluded.effective_to,
           archived_at = excluded.archived_at`,
        )
        .run(
          m.id,
          rev,
          json,
          need(m.row, "code", stream, m.id),
          need(m.row, "rate", stream, m.id),
          need(m.row, "kind", stream, m.id),
          need(m.row, "rounding_mode", stream, m.id),
          opt(m.row, "output_account_id"),
          opt(m.row, "input_account_id"),
          opt(m.row, "effective_from"),
          opt(m.row, "effective_to"),
          opt(m.row, "archived_at"),
        );
      return;
    case "cashier": {
      // A credential the till has not seen — a manager's PIN reset, or a new cashier — clears that employee
      // number's PIN lockout (ADR 0060's PR 12 amendment): the back office is the supervised unlock, and a
      // snapshot-only change leaves the lockout where it is. The till-wide throttle is not touched.
      const pinHash = need(m.row, "pin_hash", stream, m.id);
      const held = db.raw
        .prepare<[string], { pin_hash: string }>(
          "select pin_hash from catalogue_cashier where id = ?",
        )
        .get(m.id);
      const employeeNumber = m.row["employee_number"];
      if (held?.pin_hash !== pinHash && typeof employeeNumber === "string")
        db.raw.prepare("delete from meta where key = ?").run(pinAttemptKey(employeeNumber));
      db.raw
        .prepare(
          `insert into catalogue_cashier (id, revision, row_json, employee_id, branch_id, pin_hash, snapshot_json, revoked_at)
         values (?, ?, ?, ?, ?, ?, ?, ?)
         on conflict (id) do update set revision = excluded.revision, row_json = excluded.row_json,
           employee_id = excluded.employee_id, branch_id = excluded.branch_id, pin_hash = excluded.pin_hash,
           snapshot_json = excluded.snapshot_json, revoked_at = excluded.revoked_at`,
        )
        .run(
          m.id,
          rev,
          json,
          need(m.row, "employee_id", stream, m.id),
          need(m.row, "branch_id", stream, m.id),
          pinHash,
          JSON.stringify(m.row["snapshot"] ?? {}),
          opt(m.row, "revoked_at"),
        );
      return;
    }
    case "branch_pos_policy":
      db.raw
        .prepare(
          `insert into catalogue_branch_pos_policy (id, revision, row_json, branch_id, max_line_discount_pct,
           max_ticket_discount_pct, max_void_amount, max_price_override_pct, blind_return_allowed,
           max_blind_return_amount, max_cash_in_drawer, require_customer_over, rounding_increment,
           paid_out_allowed, max_paid_out_amount)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         on conflict (id) do update set revision = excluded.revision, row_json = excluded.row_json,
           branch_id = excluded.branch_id, max_line_discount_pct = excluded.max_line_discount_pct,
           max_ticket_discount_pct = excluded.max_ticket_discount_pct, max_void_amount = excluded.max_void_amount,
           max_price_override_pct = excluded.max_price_override_pct, blind_return_allowed = excluded.blind_return_allowed,
           max_blind_return_amount = excluded.max_blind_return_amount, max_cash_in_drawer = excluded.max_cash_in_drawer,
           require_customer_over = excluded.require_customer_over, rounding_increment = excluded.rounding_increment,
           paid_out_allowed = excluded.paid_out_allowed, max_paid_out_amount = excluded.max_paid_out_amount`,
        )
        .run(
          m.id,
          rev,
          json,
          need(m.row, "branch_id", stream, m.id),
          need(m.row, "max_line_discount_pct", stream, m.id),
          need(m.row, "max_ticket_discount_pct", stream, m.id),
          need(m.row, "max_void_amount", stream, m.id),
          need(m.row, "max_price_override_pct", stream, m.id),
          bool(m.row, "blind_return_allowed"),
          need(m.row, "max_blind_return_amount", stream, m.id),
          opt(m.row, "max_cash_in_drawer"),
          opt(m.row, "require_customer_over"),
          need(m.row, "rounding_increment", stream, m.id),
          bool(m.row, "paid_out_allowed"),
          need(m.row, "max_paid_out_amount", stream, m.id),
        );
      return;
  }
}

/** A tombstone (spec:1300 — "Deletions travel as tombstones, never as silent absence"). */
export function deleteMirror(db: PosDatabase, stream: Stream, id: string): void {
  switch (stream) {
    case "item":
      db.raw.prepare("delete from catalogue_item where id = ?").run(id);
      return;
    case "price_list":
      db.raw.prepare("delete from catalogue_price_list where id = ?").run(id);
      return;
    case "price_list_line":
      db.raw.prepare("delete from catalogue_price_list_line where id = ?").run(id);
      return;
    case "promotion":
      db.raw.prepare("delete from catalogue_promotion where id = ?").run(id);
      return;
    case "customer":
      db.raw.prepare("delete from catalogue_customer where id = ?").run(id);
      return;
    case "tax_code":
      db.raw.prepare("delete from catalogue_tax_code where id = ?").run(id);
      return;
    case "cashier":
      db.raw.prepare("delete from catalogue_cashier where id = ?").run(id);
      return;
    case "branch_pos_policy":
      db.raw.prepare("delete from catalogue_branch_pos_policy where id = ?").run(id);
      return;
  }
}
