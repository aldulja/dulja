import { grantCodes } from "../fixtures";
import type { TransactionSql } from "postgres";
import { schemaFingerprint as schemaFingerprintOf } from "../support/schema-fingerprint";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lintSchema } from "../../src/lint-schema";
import { down, listApplied, up } from "../../src/migrate";
import { MIGRATIONS_DIR, startDb, uuidv7, withTenant, type Db } from "../harness";
import { draftDocument, seedTenant, type Seed } from "../fixtures";

describe("migration 0057 — app.einvoice_transmission and the company e-invoice columns", () => {
  let db: Db;
  let a: Seed;
  let b: Seed;
  let docA: string;

  beforeAll(async () => {
    db = await startDb();
    a = await seedTenant(db, "einvoice-a");
    await grantCodes(db, a); // 6C: explicit company-wide branch visibility; no permission codes.
    b = await seedTenant(db, "einvoice-b");
    await grantCodes(db, b); // 6C: explicit company-wide branch visibility; no permission codes.
    docA = await draftDocument(db, a);
  }, 180_000);

  afterAll(async () => {
    await db.stop();
  });

  it("carries §4.9.3's columns plus amendment 6's four, at the declared types", async () => {
    const rows = await db.admin<{ column_name: string; data_type: string; is_nullable: string }[]>`
      select column_name, data_type, is_nullable
        from information_schema.columns
       where table_schema = 'app' and table_name = 'einvoice_transmission'
       order by column_name`;
    const byName = new Map(rows.map((r) => [r.column_name, r]));

    // §4.9.3's own list.
    for (const c of [
      "company_id",
      "document_id",
      "transmitter",
      "external_id",
      "status",
      "attempts",
      "last_error",
      "request_sha256",
      "response",
      "submitted_at",
      "accepted_at",
      "cancelled_at",
      "created_at",
    ]) {
      expect(byName.has(c), `§4.9.3 column ${c}`).toBe(true);
    }
    // Amendment 6's four.
    for (const c of ["profile_version", "qr_payload", "polled_at", "claimed_at"]) {
      expect(byName.has(c), `amendment 6 column ${c}`).toBe(true);
    }
    // The binding form of §3.3.
    expect(byName.get("id")!.data_type).toBe("uuid");
    expect(byName.get("tenant_id")!.is_nullable).toBe("NO");
    expect(byName.get("created_at")!.is_nullable).toBe("NO");
    expect(byName.get("attempts")!.is_nullable).toBe("NO");
    expect(byName.get("status")!.is_nullable).toBe("NO");
    expect(byName.get("request_sha256")!.data_type).toBe("bytea");
    expect(byName.get("response")!.data_type).toBe("jsonb");
    // No *_by column: the acting principal is the audit row's, and a transmission is not attributed.
    expect(rows.filter((r) => r.column_name.endsWith("_by"))).toHaveLength(0);
  });

  it("forces RLS, names the policy tenant_isolation, and audits", async () => {
    const [t] = await db.admin<{ relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
      select relrowsecurity, relforcerowsecurity
        from pg_class where oid = 'app.einvoice_transmission'::regclass`;
    expect(t!.relrowsecurity).toBe(true);
    expect(t!.relforcerowsecurity).toBe(true);

    const policies = await db.admin<{ policyname: string; permissive: string }[]>`
      select policyname, permissive from pg_policies
       where schemaname = 'app' and tablename = 'einvoice_transmission' order by policyname`;
    expect(policies.map((p) => p.policyname)).toEqual(["tenant_isolation"]);

    const triggers = await db.admin<{ tgname: string }[]>`
      select tgname from pg_trigger
       where tgrelid = 'app.einvoice_transmission'::regclass and not tgisinternal order by tgname`;
    expect(triggers.map((t2) => t2.tgname)).toContain("audit_row");
  });

  it("refuses a status, a transmitter and a credential ref outside their vocabularies", async () => {
    // ONE failing statement per `withTenant`. `withTenant` is one transaction (§4.2.2), and a
    // rejected statement aborts it: a second statement in the same block fails with SQLSTATE 25P02
    // ("current transaction is aborted") whose message names no CHECK constraint, so the second
    // assertion could never match its pattern. Each refusal therefore gets its own transaction.
    await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      const id = await uuidv7(db.admin);
      await expect(
        (tx as unknown as TransactionSql).savepoint(
          (sp) => sp`
        insert into app.einvoice_transmission (id, tenant_id, company_id, document_id, transmitter, status)
        values (${id}, ${a.tenant}, ${a.company}, ${docA}, 'synthetic', 'posted')
      `,
        ),
      ).rejects.toThrow(/einvoice_transmission_status_check/);
    });

    await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      const id = await uuidv7(db.admin);
      await expect(
        (tx as unknown as TransactionSql).savepoint(
          (sp) => sp`
        insert into app.einvoice_transmission (id, tenant_id, company_id, document_id, transmitter, status)
        values (${id}, ${a.tenant}, ${a.company}, ${docA}, 'zatca', 'pending')
      `,
        ),
      ).rejects.toThrow(/einvoice_transmission_transmitter_check/);
    });

    await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      await expect(
        (tx as unknown as TransactionSql).savepoint(
          (sp) => sp`
        update app.company set einvoice_transmitter = 'synthetic',
                               einvoice_client_id = 'client-a',
                               einvoice_credential_ref = 'DATABASE_URL'
         where id = ${a.company}
      `,
        ),
      ).rejects.toThrow(/company_einvoice_credential_ref_check/);
    });
  });

  it("requires the three company columns together or not at all", async () => {
    await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      await expect(
        (tx as unknown as TransactionSql).savepoint(
          (sp) => sp`
        update app.company set einvoice_transmitter = 'synthetic' where id = ${a.company}
      `,
        ),
      ).rejects.toThrow(/company_einvoice_complete_check/);
    });
    await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      await tx`
        update app.company set einvoice_transmitter = 'synthetic',
                               einvoice_client_id = 'client-a',
                               einvoice_credential_ref = 'EINVOICE_CLIENT_SECRET'
         where id = ${a.company}`;
      const [c] = await tx<{ einvoice_transmitter: string }[]>`
        select einvoice_transmitter from app.company where id = ${a.company}`;
      expect(c!.einvoice_transmitter).toBe("synthetic");
    });
  });

  it("holds one transmission per document (spec:2225 — a log, not a queue)", async () => {
    // TWO `withTenant` blocks, and the split is load-bearing for the NEXT `it` as well as this one.
    // `withTenant` is one transaction (§4.2.2); a unique violation aborts it, so Postgres turns the
    // enclosing COMMIT into a ROLLBACK and the successful first insert would never be persisted.
    // The following `it` counts tenant A's rows and expects 1, so keeping both statements in one
    // block would make this `it` pass and the next one fail — the same hazard the vocabulary `it`
    // three above already splits for, applied to a SUCCESS followed by a refusal rather than to two
    // refusals.
    const first = await uuidv7(db.admin);
    const second = await uuidv7(db.admin);

    await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      await tx`insert into app.einvoice_transmission (id, tenant_id, company_id, document_id, transmitter)
               values (${first}, ${a.tenant}, ${a.company}, ${docA}, 'synthetic')`;
    });

    await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      await expect(
        (tx as unknown as TransactionSql).savepoint(
          (sp) => sp`
        insert into app.einvoice_transmission (id, tenant_id, company_id, document_id, transmitter)
        values (${second}, ${a.tenant}, ${a.company}, ${docA}, 'synthetic')
      `,
        ),
      ).rejects.toThrow(/einvoice_transmission_tenant_id_document_id_key/);
    });

    // The committed row survived the aborted transaction that followed it.
    const [row] = await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) =>
        tx<
          { id: string }[]
        >`select id::text as id from app.einvoice_transmission where document_id = ${docA}`,
    );
    expect(row!.id).toBe(first);
  });

  it("a second tenant cannot see it (spec:106)", async () => {
    const seen = await withTenant(
      db.rw,
      b.tenant,
      b.human,
      (tx) => tx<{ n: number }[]>`select count(*)::int as n from app.einvoice_transmission`,
    );
    expect(seen[0]!.n).toBe(0);

    const own = await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx<{ n: number }[]>`select count(*)::int as n from app.einvoice_transmission`,
    );
    expect(own[0]!.n).toBe(1);

    // And tenant B cannot WRITE a row keyed to tenant A's document: the RLS `with check` refuses.
    await withTenant(db.rw, b.tenant, b.human, async (tx) => {
      const id = await uuidv7(db.admin);
      await expect(
        (tx as unknown as TransactionSql).savepoint(
          (sp) => sp`
        insert into app.einvoice_transmission (id, tenant_id, company_id, document_id, transmitter)
        values (${id}, ${a.tenant}, ${a.company}, ${docA}, 'synthetic')
      `,
        ),
      ).rejects.toThrow();
    });
  });

  it("reports zero linter violations after 0057", async () => {
    expect(await lintSchema(db.admin)).toEqual([]);
  });

  it("up → down → up reproduces the schema byte for byte", async () => {
    const before = await schemaFingerprintOf(db.migrator);
    const applied = await listApplied(db.migrator);
    expect(await down(db.migrator, MIGRATIONS_DIR)).toEqual([...applied].toReversed());
    expect(await up(db.migrator, MIGRATIONS_DIR)).toEqual(applied);
    expect(await schemaFingerprintOf(db.migrator)).toBe(before);
  }, 180_000);
});
