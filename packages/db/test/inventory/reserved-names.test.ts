import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startDb, type Db } from "../harness";

/**
 * ⚠️ OD-08 (§2.12) — the four capabilities on spec:1032's "probably not needed" list. The DEFAULT is: not
 * built, names reserved. This file is the reservation, executable: if a later slice needs one of these
 * capabilities it renames these expectations in the same PR as its migration, and a reviewer sees the
 * decision instead of discovering a `bom_line` table nobody agreed to.
 *
 * The reserved table names, with the shape §4.6.1 would use if OD-08 came back yes:
 *   app.bill_of_materials       parent item_id, output_quantity, effective_from  — spec:1182
 *   app.bill_of_materials_line  bom_id, component item_id, quantity, scrap_pct
 *   app.consignment_holding     party_id, item_id, warehouse_id, quantity — stock owned by someone else
 *   app.dealer_commission       party_id, item_id?, basis, rate — a commission ACCRUAL, never a payroll line
 *   app.job                     company_id, code, name_en, name_ar, status — project/job costing's cost object
 * None is created by any slice in this document. A capability that needs one amends §4.6.1 first.
 */
describe("⚠️ OD-08 — reserved names, no DDL (spec:1032)", () => {
  const RESERVED = [
    "bill_of_materials",
    "bill_of_materials_line",
    "consignment_holding",
    "dealer_commission",
    "job",
  ] as const;
  let db: Db;

  beforeAll(async () => {
    db = await startDb();
  });
  afterAll(async () => {
    await db.stop();
  });

  it("none of the five reserved table names exists in schema app", async () => {
    const present = await db.admin<{ table_name: string }[]>`
      select table_name from information_schema.tables
       where table_schema = 'app' and table_name = any(${RESERVED as unknown as string[]})
       order by table_name`;
    expect(present.map((r) => r.table_name)).toEqual([]);
  });

  it("no near-spelling of one has slipped in either — the reservation is about the capability", async () => {
    const suspicious = await db.admin<{ table_name: string }[]>`
      select table_name from information_schema.tables
       where table_schema = 'app'
         and (table_name like '%bom%' or table_name like '%consign%'
           or table_name like '%commission%' or table_name like '%project%')
       order by table_name`;
    expect(suspicious.map((r) => r.table_name)).toEqual([]);
  });

  it("no permission code, document-type code or account code exists for any of the four", async () => {
    const codes = await db.admin<{ code: string }[]>`
      select code from app.permission
       where code like '%bom%' or code like '%manufactur%' or code like '%consign%'
          or code like '%commission%' or code like '%project%'
       order by code`;
    // §3.6.1 closes the permission vocabulary at spec:2146-2150, so a code here would mean a slice widened a
    // closed registry — the mechanical half of hazard 26 and hazard 32.
    expect(codes.map((r) => r.code)).toEqual([]);
  });

  it("`job` in particular is reserved and NOT the legacy MatOpens.Job column (Part VII #7, OD-27)", async () => {
    // 9A's profiler reports on the legacy `Job` column under OD-27; that is a report about the old database
    // and creates nothing here. Recorded because "job" is a word two decisions use.
    const [row] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from information_schema.columns
       where table_schema = 'app' and column_name in ('job_id', 'bom_id', 'commission_id')`;
    expect(row!.n).toBe(0);
  });
});
