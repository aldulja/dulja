import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lintSchema } from "../../src/lint-schema";
import {
  archivePaymentTerm,
  createPaymentTerm,
  dueDateFor,
  listPaymentTerms,
  updatePaymentTerm,
} from "../../src/ar-ap/payment-term";
import {
  grantCodes,
  seedTenantV2,
  startDb,
  uuidv7,
  withTenant,
  type Db,
  type Seed,
} from "../index";

let db: Db;
let s: Seed;
let other: Seed;
const ctxOf = (seed: Seed) => ({
  tenantId: seed.tenant,
  actorId: seed.human,
  requestId: "00000000-0000-0000-0000-000000000000",
});

beforeAll(async () => {
  db = await startDb();
  s = await seedTenantV2(db, "payment-term");
  // 0127 (ADR 0095): the days-pinned guard answers only to a live role in the company.
  await grantCodes(db, s, {});
  other = await seedTenantV2(db, "payment-term-other");
}, 180_000);
afterAll(async () => {
  await db.stop();
});

describe("app.payment_term — migration 0044, contracts §4.6.1", () => {
  it("the schema linter reports zero violations after 0044", async () => {
    expect(await lintSchema(db.admin)).toEqual([]);
  });

  it("creates a term, defaults nameAr, discountDays and discountPct to null, and round-trips every column", async () => {
    const row = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      createPaymentTerm(tx, ctxOf(s), {
        companyId: s.company,
        code: "NET30",
        nameEn: "Net 30 days",
        dueDays: 30,
      }),
    );
    expect(row.code).toBe("NET30");
    expect(row.companyId).toBe(s.company);
    expect(row.nameEn).toBe("Net 30 days");
    expect(row.dueDays).toBe(30);
    expect(row.nameAr).toBeNull();
    expect(row.discountDays).toBeNull();
    expect(row.discountPct).toBeNull();
    expect(row.archivedAt).toBeNull();
  });

  it("keeps discount_pct as a 6-dp STRING — never a JavaScript number (no-number-money, §3.7.5)", async () => {
    const row = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      createPaymentTerm(tx, ctxOf(s), {
        companyId: s.company,
        code: "2-10-N30",
        nameEn: "2% 10 days, net 30",
        dueDays: 30,
        discountDays: 10,
        discountPct: "0.020000",
      }),
    );
    expect(row.discountPct).toBe("0.020000");
    expect(typeof row.discountPct).toBe("string");
    expect(row.discountDays).toBe(10);
  });

  it("refuses a duplicate (company, code) with ERR_CONFLICT_UNIQUE", async () => {
    await expect(
      withTenant(db.rw, s.tenant, s.human, (tx) =>
        createPaymentTerm(tx, ctxOf(s), {
          companyId: s.company,
          code: "NET30",
          nameEn: "again",
          dueDays: 30,
        }),
      ),
    ).rejects.toThrow(/ERR_CONFLICT_UNIQUE/);
  });

  it("refuses a negative due_days at the database, not at the service", async () => {
    await expect(
      withTenant(
        db.rw,
        s.tenant,
        s.human,
        (tx) =>
          tx`insert into app.payment_term (tenant_id, company_id, code, name_en, due_days)
             values (${s.tenant}, ${s.company}, ${"BAD"}, ${"bad"}, ${-1})`,
      ),
    ).rejects.toThrow(/payment_term_due_days_check/);
  });

  it("refuses discount_days greater than due_days at the database (a discount after the due date is not a discount)", async () => {
    await expect(
      withTenant(
        db.rw,
        s.tenant,
        s.human,
        (tx) =>
          tx`insert into app.payment_term (tenant_id, company_id, code, name_en, due_days, discount_days, discount_pct)
             values (${s.tenant}, ${s.company}, ${"BAD2"}, ${"bad"}, ${10}, ${20}, ${"0.010000"})`,
      ),
    ).rejects.toThrow(/payment_term_discount_window_check/);
  });

  it("archives rather than deletes, and archived rows are hidden from the default list (spec:2049)", async () => {
    const id = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      async (tx) =>
        (
          await createPaymentTerm(tx, ctxOf(s), {
            companyId: s.company,
            code: "COD",
            nameEn: "Cash on delivery",
            dueDays: 0,
          })
        ).id,
    );
    const archived = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      archivePaymentTerm(tx, ctxOf(s), { companyId: s.company, paymentTermId: id }),
    );
    expect(archived.archivedAt).not.toBeNull();
    const visible = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      listPaymentTerms(tx, { companyId: s.company, limit: 50 }),
    );
    expect(visible.map((r) => r.code)).not.toContain("COD");
    const all = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      listPaymentTerms(tx, { companyId: s.company, includeArchived: true, limit: 50 }),
    );
    expect(all.map((r) => r.code)).toContain("COD");
  });

  it("updatePaymentTerm changes due_days and leaves the code alone (renaming a code is forbidden)", async () => {
    const [row] = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      listPaymentTerms(tx, { companyId: s.company, limit: 1 }),
    );
    const updated = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      updatePaymentTerm(tx, ctxOf(s), {
        companyId: s.company,
        paymentTermId: row!.id,
        dueDays: 45,
      }),
    );
    expect(updated.dueDays).toBe(45);
    expect(updated.code).toBe(row!.code);
  });

  it("update and archive are bound to the caller's company: another company's id is ERR_NOT_FOUND (AGENTS.md)", async () => {
    // RLS bounds the tenant and nothing else, so an id alone would reach a sibling company's term. The
    // services take the company the route's gate cleared and match on it.
    const [row] = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      listPaymentTerms(tx, { companyId: s.company, limit: 1 }),
    );
    const sibling = await uuidv7(db.admin);
    await expect(
      withTenant(db.rw, s.tenant, s.human, (tx) =>
        updatePaymentTerm(tx, ctxOf(s), { companyId: sibling, paymentTermId: row!.id, dueDays: 1 }),
      ),
    ).rejects.toThrow(/ERR_NOT_FOUND/);
    await expect(
      withTenant(db.rw, s.tenant, s.human, (tx) =>
        archivePaymentTerm(tx, ctxOf(s), { companyId: sibling, paymentTermId: row!.id }),
      ),
    ).rejects.toThrow(/ERR_NOT_FOUND/);
  });

  it("dueDateFor computes effective_date + due_days IN SQL, and a null term is due on the day (§4.8.2)", async () => {
    const id = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      async (tx) =>
        (
          await createPaymentTerm(tx, ctxOf(s), {
            companyId: s.company,
            code: "NET60",
            nameEn: "Net 60",
            dueDays: 60,
          })
        ).id,
    );
    await withTenant(db.rw, s.tenant, s.human, async (tx) => {
      expect(await dueDateFor(tx, { paymentTermId: id, effectiveDate: "2026-01-15" })).toBe(
        "2026-03-16",
      );
      expect(await dueDateFor(tx, { paymentTermId: null, effectiveDate: "2026-01-15" })).toBe(
        "2026-01-15",
      );
    });
  });

  it("a second tenant cannot see or write this tenant's terms (spec:106)", async () => {
    const mine = await withTenant(db.rw, other.tenant, other.human, (tx) =>
      listPaymentTerms(tx, { companyId: s.company, limit: 50 }),
    );
    expect(mine).toEqual([]);
    const stolenId = await uuidv7(db.admin);
    await expect(
      withTenant(
        db.rw,
        other.tenant,
        other.human,
        (tx) =>
          tx`insert into app.payment_term (id, tenant_id, company_id, code, name_en, due_days)
             values (${stolenId}, ${other.tenant}, ${s.company}, ${"X"}, ${"x"}, ${1})`,
      ),
    ).rejects.toThrow(); // the composite FK (tenant_id, company_id) has no row to point at
  });

  it("every write is audited (test 13 re-run over this table)", async () => {
    const [n] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from app.audit_log where table_name = 'payment_term'`;
    expect(n!.n).toBeGreaterThan(0);
  });
});
