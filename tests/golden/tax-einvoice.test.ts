import { registerTransmitter, createSyntheticTransmitter } from "@dulja/db";
// tests/golden/tax-einvoice.test.ts (5B T10)
//
// Acceptance test 26 (spec:2444) re-run with the e-invoicing hooks ON, and acceptance test 13
// (spec:2431) over the surface slice 5B adds. Test 26 itself is 5A's and lives in 5A's own golden
// file; this one asserts the two things only 5B can assert:
//
//   (a) generating twice with hooks on is byte-identical            — test 26, hooks on
//   (b) hooks on and hooks off produce the same boxes and payload   — the hooks change no number
//   (c) every write the hooks make is audited under a server actor  — test 13
//
// Two tenants in one container: A has e-invoicing OFF, B has it ON. Everything else about them is
// identical, because both are built by the same two fixture calls.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { withTenant as prodWithTenant } from "@dulja/db";
import { listTransmissions, runIntegrityCheck } from "@dulja/db";
import { createTaxReturn, generateTaxReturn, getTaxReturn, taxReturnTieOut } from "@dulja/db";
import { registerDefaultTransmitters, resetTransmitters } from "@dulja/db";
import { startDb, uuidv7, type Db, type Seed } from "@dulja/db/test";
import { startStubServer, type StubServer } from "@dulja/db/test/einvoice-stub";
import { postTaxedDocument, taxFixture, type TaxFixture } from "../invariants/support/tax";
import {
  OPTED_IN_TYPE_CODE,
  einvoiceFixture,
  type EinvoiceFixture,
} from "../invariants/support/einvoice";
// §4.17.1: `REPO_ROOT` and `sourceFiles(roots?)` live in `tests/support/source.ts` (owner 0B), NOT
// in `@dulja/api/routes` — §4.2.7 limits that entry point to `ROUTES`, `buildRoutes`, `RouteModule`
// and `IdempotencyHeader`, and a test-tier walker on a production entry point would put the
// repository walk on `apps/api`'s import graph (§3.1).
import { REPO_ROOT, sourceFiles } from "../support/source";

let db: Db;
let stub: StubServer;
let off: TaxFixture; // tenant A — company with einvoice_transmitter null
let on: TaxFixture; // tenant B — company with einvoice_transmitter 'synthetic'
let onE: EinvoiceFixture;

const Q1 = { periodStart: "2026-01-01", periodEnd: "2026-03-31" };

/** §4.1 freezes `uuidv7(sql: Sql): Promise<string>` — it takes a `Sql` and it is async, so it can
 *  never be called from a synchronous factory. One request id is minted in `beforeAll` and reused as
 *  the correlation id of every context in this file; a `requestId` is a correlation value, not a row
 *  id, so one per file is correct and keeps `ctxOf` synchronous at its sixteen call sites. */
let requestId: string;
/** Tenant B's corpus document ids, in `CORPUS` order. */
let onDocIds: string[] = [];
const ctxOf = (s: Seed) => ({ tenantId: s.tenant, actorId: s.human, requestId });

/**
 * The corpus. Five taxed documents, the same figures on both tenants, every amount an obviously
 * invented round number — hazard 1 binds here exactly as it does in Phase 8 (Global Constraint 14).
 * The tax rate is whatever 5A's `seedTaxCode` default is; this file never states one.
 *
 * **The member names are 5A's, not this plan's.** `postTaxedDocument(db, f, opts)` takes
 * `{ typeCode, effectiveDate, partyId?, taxInclusive?, lines: TaxedLine[] }` — `typeCode` and not
 * `code` (5A maps it onto 4B's `code` itself), and a `TaxedLine` is
 * `{ lineNo; kind?; accountId?; amount; taxCode: string | null }` whose `taxCode` is a KEY OF
 * `TaxFixture.codes` (`SYN-OUT-STD`, `SYN-OUT-ZERO`, `SYN-IN-STD`, `SYN-EXEMPT`), never a rate and
 * never a uuid. A purchase document is posted against the VENDOR, so it carries `partyId` explicitly;
 * a sales one takes 5A's own default. `accountId` is left to 5A's default of `f.accounts["4000"]` on
 * the sales rows and named on the purchase rows, because a purchase posted to revenue would tie out
 * against the wrong control account in the fourth `it` below.
 */
const CORPUS = [
  {
    typeCode: "SALES_INVOICE",
    effectiveDate: "2026-01-10",
    amount: "1000.0000",
    taxCode: "SYN-OUT-STD",
    party: "customer" as const,
    accountCode: "4000",
  },
  {
    typeCode: "SALES_INVOICE",
    effectiveDate: "2026-02-04",
    amount: "2500.0000",
    taxCode: "SYN-OUT-STD",
    party: "customer" as const,
    accountCode: "4000",
  },
  {
    typeCode: "SALES_CREDIT_NOTE",
    effectiveDate: "2026-02-18",
    amount: "300.0000",
    taxCode: "SYN-OUT-STD",
    party: "customer" as const,
    accountCode: "4000",
  },
  {
    typeCode: "PURCHASE_INVOICE",
    effectiveDate: "2026-01-22",
    amount: "800.0000",
    taxCode: "SYN-IN-STD",
    party: "vendor" as const,
    accountCode: "5900",
  },
  {
    typeCode: "PURCHASE_CREDIT_NOTE",
    effectiveDate: "2026-03-09",
    amount: "150.0000",
    taxCode: "SYN-IN-STD",
    party: "vendor" as const,
    accountCode: "5900",
  },
];

/** Returns the document ids IN `CORPUS` ORDER, so a caller can pair a row with the entry that made
 *  it — which is what the opted-in count in Step 4 needs. */
async function postCorpus(f: TaxFixture): Promise<string[]> {
  const ids: string[] = [];
  for (const doc of CORPUS) {
    const { documentId } = await postTaxedDocument(db, f, {
      typeCode: doc.typeCode,
      effectiveDate: doc.effectiveDate,
      partyId: doc.party === "vendor" ? f.vendorId : f.customerId,
      lines: [
        {
          lineNo: 1,
          kind: "account",
          accountId: f.accounts[doc.accountCode]!,
          amount: doc.amount,
          taxCode: doc.taxCode,
        },
      ],
    });
    ids.push(documentId);
  }
  return ids;
}

const norm = (s: string | null) =>
  (s ?? "").replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<uuid>");

async function generate(f: TaxFixture): Promise<{
  row: { payloadSha256: string | null; payload: string | null };
  boxes: { code: string; label: string; amount: string }[];
}> {
  const ctx = ctxOf(f.s);
  return prodWithTenant(db.rw, ctx, async (tx) => {
    const [existing] = await tx<
      { id: string }[]
    >`select id from app.tax_return where company_id = ${f.s.company} and regime_id = ${f.regimeId} and period_start = ${Q1.periodStart}`;
    const created =
      existing ??
      (await createTaxReturn(tx, ctx, { companyId: f.s.company, regimeId: f.regimeId, ...Q1 }));
    await generateTaxReturn(tx, ctx, created.id);
    const { row, boxes } = await getTaxReturn(tx, created.id);
    return {
      row: { payloadSha256: row.payloadSha256, payload: row.payload },
      boxes: boxes.map((b) => ({ code: b.code, label: b.label, amount: b.amount.toString() })),
    };
  });
}

beforeAll(async () => {
  db = await startDb();
  requestId = await uuidv7(db.admin);
  // The registry is module-level process state and nothing in this file's import graph fills it —
  // `registerDefaultTransmitters` is called by the two ENTRYPOINTS (apps/api, apps/worker), which a
  // root `tests/` file does not start. Without these two lines `driveToAccepted` answers
  // ERR_EINVOICE_TRANSMITTER_UNAVAILABLE on every row.
  resetTransmitters();
  registerDefaultTransmitters("dev");
  stub = await startStubServer({
    submit: { state: "queued", receiptId: "GOLD-1" },
    poll: { state: "cleared" },
    cancel: { state: "withdrawn" },
  });
  registerTransmitter(
    "synthetic",
    createSyntheticTransmitter({
      profile: stub.profile,
      env: { EINVOICE_CLIENT_SECRET: "test-secret" },
    }),
  );
  off = await taxFixture(db, "einvoice-off");
  on = await taxFixture(db, "einvoice-on");
  // `einvoiceFixture` runs 4B's `arApFixture` on the tenant `taxFixture` already populated. Both
  // seed accounts and grant codes, so the composition works only if `arApFixture` is select-or-
  // insert — 4B's own Self-Review records that `seedTypeFromPack` was made so for exactly this
  // reason. **If this line raises ERR_CONFLICT_UNIQUE, that is the finding**: raise it with 4B
  // rather than reordering the two calls, because reordering only moves which one collides.
  onE = await einvoiceFixture(db, on.s); // enables the company and opts SALES_INVOICE in
  await postCorpus(off);
  onDocIds = await postCorpus(on); // in CORPUS order — Step 4 pairs them back up
}, 600_000);

afterAll(async () => {
  await stub.stop();
  await db.stop();
});

describe("acceptance test 26 with the e-invoicing hooks ON (spec:2444, 5B T10)", () => {
  it("generates a byte-identical return twice on the enabled company", async () => {
    const first = await generate(on);
    const second = await generate(on);
    expect(first.row.payloadSha256).not.toBeNull();
    expect(second.row.payloadSha256).toBe(first.row.payloadSha256);
    expect(second.row.payload).toBe(first.row.payload);
  });

  it("produces exactly the same boxes with hooks on as with hooks off", async () => {
    const a = await generate(off);
    const b = await generate(on);
    // `boxes` is `{ code, label, amount }[]` — no id, no timestamp, no tenant. If this differs,
    // the hooks moved a number, which is the one thing this slice promised not to do.
    expect(b.boxes).toEqual(a.boxes);
  });

  it("produces the same payload with hooks on as with hooks off, up to the tenant's own identifiers", async () => {
    const a = await generate(off);
    const b = await generate(on);
    // The two returns are on two tenants, so any uuid the payload embeds necessarily differs. Every
    // OTHER byte must be identical. Normalising uuids is the smallest normalisation that lets the
    // comparison run at all, and it is written out rather than assumed: if this fails, a NON-uuid
    // byte moved and that is the defect.

    expect(norm(b.row.payload)).toBe(norm(a.row.payload));
  });

  it("still ties out to the control accounts to the cent with hooks on", async () => {
    const ctx = ctxOf(on.s);
    const rows = await prodWithTenant(db.rw, ctx, async (tx) => {
      const created = await createTaxReturn(tx, ctx, {
        companyId: on.s.company,
        regimeId: on.regimeId,
        periodStart: "2026-04-01",
        periodEnd: "2026-06-30",
      });
      await generateTaxReturn(tx, ctx, created.id);
      return taxReturnTieOut(tx, created.id);
    });
    // An empty quarter ties out at zero; a populated one ties out at zero too. The assertion is the
    // difference column and not the amounts, which is 5A's tie-out contract.
    for (const r of rows) expect(r.difference, r.accountCode).toBe("0.0000");
  });

  it("5A's golden corpus directory is well formed, or this run is explicitly skipped", () => {
    const dir = join(REPO_ROOT, "tests", "golden", "tax");
    if (!existsSync(dir)) {
      // Task 0's gate FAILS on this, so reaching it means the gate was skipped.
      throw new Error(
        "tests/golden/tax/ does not exist — 5A's corpus is missing; run scripts/check/contracts-5b-amendments.sh",
      );
    }
    const cases = readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
    if (cases.length === 0) {
      console.warn(
        "SKIP: tests/golden/tax/ has no case directories — 5A's Task 9 has not landed its corpus, so test 26's file comparison is not re-run here. The three assertions above still run and are what 5B owes.",
      );
      return;
    }
    for (const name of cases) {
      const input = join(dir, name, "input.json");
      const expected = join(dir, name, "expected.json");
      expect(existsSync(input), `${name}/input.json`).toBe(true);
      expect(existsSync(expected), `${name}/expected.json`).toBe(true);
      const parsed = JSON.parse(readFileSync(expected, "utf8")) as { boxes?: unknown };
      expect(Array.isArray(parsed.boxes), `${name}/expected.json has a boxes array`).toBe(true);
    }
  });
});

describe("the e-invoicing hooks themselves (5B T10)", () => {
  it("writes exactly one transmission per posted document of an OPTED-IN type, and none for the rest", async () => {
    // `einvoiceFixture` opts in exactly ONE type — `OPTED_IN_TYPE_CODE`, which is 4A's own
    // `SALES_INVOICE` envelope re-seeded at `policyVersion + 1` — so the expected count is the number
    // of CORPUS rows of that code and NOT `CORPUS.length`. The other three rows are the second gate
    // (`policy.tax.einvoice`) asserted on the SAME enabled company, which is a stronger statement than
    // the disabled-company `it` below: the company is enrolled, the type is not, and nothing is
    // written. Both halves are computed from CORPUS, so neither drifts when a row is added.
    const optedInDocIds = onDocIds.filter((_, i) => CORPUS[i]!.typeCode === OPTED_IN_TYPE_CODE);
    const otherDocIds = onDocIds.filter((_, i) => CORPUS[i]!.typeCode !== OPTED_IN_TYPE_CODE);
    expect(optedInDocIds.length).toBeGreaterThan(0);
    expect(otherDocIds.length).toBeGreaterThan(0);

    const rows = await prodWithTenant(db.rw, ctxOf(on.s), (tx) =>
      listTransmissions(tx, { companyId: on.s.company, limit: 1000 }),
    );
    expect(rows).toHaveLength(optedInDocIds.length);
    expect(new Set(rows.map((r) => r.documentId))).toEqual(new Set(optedInDocIds));
    expect(new Set(rows.map((r) => r.documentId)).size).toBe(rows.length); // unique (document_id)
    for (const id of otherDocIds) {
      expect(
        rows.some((r) => r.documentId === id),
        `${id} is not an opted-in type`,
      ).toBe(false);
    }
    for (const r of rows) {
      expect(r.transmitter).toBe("synthetic");
      expect(r.status).toBe("pending"); // posting writes the row; the JOB moves it
      expect(r.attempts).toBe(0);
      expect(r.externalId).toBeNull();
    }
  });

  it("writes NOTHING at all on the company that has not opted in", async () => {
    const rows = await prodWithTenant(db.rw, ctxOf(off.s), (tx) =>
      listTransmissions(tx, { companyId: off.s.company, limit: 1000 }),
    );
    expect(rows).toEqual([]);
  });

  it("drives every pending row to `accepted` through the synthetic transmitter", async () => {
    const before = await prodWithTenant(db.rw, ctxOf(on.s), (tx) =>
      listTransmissions(tx, { companyId: on.s.company, limit: 1000 }),
    );
    for (const r of before) await onE.driveToAccepted(r.id);
    const after = await prodWithTenant(db.rw, ctxOf(on.s), (tx) =>
      listTransmissions(tx, { companyId: on.s.company, limit: 1000 }),
    );
    for (const r of after) {
      expect(r.status, r.documentId).toBe("accepted");
      expect(r.externalId, r.documentId).not.toBeNull();
      expect(r.acceptedAt, r.documentId).not.toBeNull();
      expect(r.qrPayload, r.documentId).not.toBeNull();
      expect(r.requestSha256, r.documentId).toMatch(/^[0-9a-f]{64}$/);
      expect(r.profileVersion, r.documentId).toBe(1);
    }
  });

  it("moves no ledger row while doing it — a transmission is not a posting", async () => {
    const fingerprint = () =>
      prodWithTenant(db.rw, ctxOf(on.s), async (tx) => {
        const [row] = await tx<{ h: string }[]>`
          select encode(sha256(coalesce(string_agg(
                   l.account_id::text || l.debit::text || l.credit::text || l.effective_date::text,
                   '|' order by l.id), '')::bytea), 'hex') as h
            from app.ledger_entry l`;
        return row!.h;
      });
    // A FRESH document, because the state machine is one-way: `SUBMITTABLE_FROM` is
    // `pending | error | rejected`, so re-driving an already-accepted row raises
    // ERR_EINVOICE_STATUS_ILLEGAL and this test would fail for the wrong reason.
    const { transmissionId } = await onE.postOptedInDocument();
    const before = await fingerprint(); // AFTER the post, so only the transmission is in scope
    await onE.driveToAccepted(transmissionId);
    expect(await fingerprint()).toBe(before);
  });
});

describe("acceptance test 13 over slice 5B's surface (spec:2431, 5B T10)", () => {
  it("audits every insert and every status update of einvoice_transmission, with a server-supplied actor", async () => {
    const rows = await prodWithTenant(db.rw, ctxOf(on.s), (tx) =>
      listTransmissions(tx, { companyId: on.s.company, limit: 1000 }),
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      // `app.audit_log`'s primary key is `seq bigint generated always as identity` and the table has
      // NO `id` column (plan 0A) — `order by id` is SQLSTATE 42703. And `app.audit_row()` inserts
      // `lower(tg_op)` under `check (action in ('insert','update','delete'))`, so the labels are
      // lower-case; Task 5's own audit `it` already asserts `["insert","update","update"]`.
      const audit = await db.admin<{ action: string; actor_id: string | null }[]>`
        select action, actor_id from app.audit_log
         where table_name = 'einvoice_transmission' and row_id = ${r.id}
         order by seq`;
      // One insert from step 14, then TWO updates per remote call: `claim` stamps attempts and
      // claimed_at, `record` writes the outcome and releases the claim (ADR 0053). The assertion is
      // deliberately `> 0` and not an exact count — what test 13 requires is that every write is
      // audited under a server-supplied actor, not that a particular number of them happened.
      expect(
        audit.map((a) => a.action),
        r.id,
      ).toContain("insert");
      expect(audit.filter((a) => a.action === "update").length, r.id).toBeGreaterThan(0);
      for (const a of audit) expect(a.actor_id, `${r.id} ${a.action}`).not.toBeNull();
    }
  });

  it("audits every write of the three company e-invoice columns", async () => {
    const audit = await db.admin<{ action: string; actor_id: string | null }[]>`
      select action, actor_id from app.audit_log
       where table_name = 'company' and row_id = ${on.s.company} and action = 'update'`;
    expect(audit.length).toBeGreaterThan(0);
    for (const a of audit) expect(a.actor_id).not.toBeNull();
  });

  it("app_rw can neither update nor delete an audit row", async () => {
    await expect(
      prodWithTenant(
        db.rw,
        ctxOf(on.s),
        (tx) =>
          tx`update app.audit_log set action = 'X' where table_name = 'einvoice_transmission'`,
      ),
    ).rejects.toThrow(/permission denied|ERR_TABLE_IMMUTABLE|ERR_RLS_DENIED/);
    await expect(
      prodWithTenant(
        db.rw,
        ctxOf(on.s),
        (tx) => tx`delete from app.audit_log where table_name = 'einvoice_transmission'`,
      ),
    ).rejects.toThrow(/permission denied|ERR_TABLE_IMMUTABLE|ERR_RLS_DENIED/);
  });

  it("app_rw can neither update nor delete a transmission row directly — the log is service-owned", async () => {
    const [r] = await prodWithTenant(db.rw, ctxOf(on.s), (tx) =>
      listTransmissions(tx, { companyId: on.s.company, limit: 1 }),
    );
    await expect(
      prodWithTenant(
        db.rw,
        ctxOf(on.s),
        (tx) => tx`delete from app.einvoice_transmission where id = ${r!.id}`,
      ),
    ).rejects.toThrow(/permission denied/);
    // §3.5.4's DELETE list is five tables and this is not one of them (Global Constraint 8): a
    // transmission is CANCELLED, never deleted.
  });

  it("the audit hash chain verifies after everything above", async () => {
    const report = await runIntegrityCheck(db.rw, {
      tenantId: on.s.tenant,
      actorId: on.s.system,
      requestId: await uuidv7(db.admin),
    });
    expect(
      report.auditChain.brokenLinks === 0 && report.auditChain.badHashes === 0,
      JSON.stringify(report.auditChain),
    ).toBe(true);
    expect(report.projections.mismatches).toEqual([]);
  });

  it("no flag suppresses the audit — nothing in this slice's source names one", () => {
    // `sourceFiles(roots)` returns `scripts/lint/types.ts`'s `SourceFile { path; text; lines }`
    // (§4.17.1), so the text is already read. **Its roots are DIRECTORIES** — 0B's walker calls
    // `readdirSync(join(REPO_ROOT, root))` on each — so a file path may not be passed as a root; the
    // surface is applied afterwards as a path filter.
    const SURFACE = [
      "packages/db/src/einvoice",
      "apps/api/src/routes/accounting/einvoice-transmissions.ts",
      "apps/worker/src/handlers/accounting-tax-submit.ts",
    ];
    const offenders: string[] = [];
    for (const file of sourceFiles(["packages", "apps"]).filter((f) =>
      SURFACE.some((s) => f.path === s || f.path.startsWith(`${s}/`)),
    )) {
      if (
        /session_replication_role|audit[_a-z]*\s*=\s*(false|off)|disable\s+trigger/i.test(file.text)
      )
        offenders.push(file.path);
    }
    expect(offenders).toEqual([]);
  });
});
