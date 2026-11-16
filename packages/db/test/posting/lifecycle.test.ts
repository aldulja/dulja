import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { postDocument, voidDocument } from "../../src/posting";
import {
  listDocumentEvents,
  recordOverride,
  setEventContext,
  transitionDocument,
} from "../../src/posting/lifecycle";
import { withTenant as prodWithTenant } from "../../src/with-tenant";
import {
  grantCodes,
  seedTenantV2,
  startDb,
  uuidv7,
  withTenant,
  type Db,
  type Seed,
} from "../index";

const ctx = (s: Seed, actorId?: string) => ({
  tenantId: s.tenant,
  actorId: actorId ?? s.human,
  requestId: "req-2b",
});

describe("transitionDocument / recordOverride — contracts §4.3.1, §4.5.3", () => {
  let db: Db;
  let a: Seed;
  let supervisor: string;

  const person = async (label: string): Promise<string> => {
    const id = await uuidv7(db.admin);
    await withTenant(db.migrator, a.tenant, a.system, async (tx) => {
      await tx`insert into app.principal (id, kind, auth_subject, display_name)
               values (${id}, 'human', ${`${label}:${a.tenant}`}, ${label})`;
      await tx`insert into app.membership (tenant_id, principal_id) values (${a.tenant}, ${id})`;
    });
    return id;
  };

  const draft = async (): Promise<string> => {
    const id = await uuidv7(db.admin);
    await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      await tx`insert into app.document (id, tenant_id, company_id, document_type_id, series, effective_date, currency, branch_id)
               values (${id}, ${a.tenant}, ${a.company}, ${a.docType}, 'JV', '2026-01-15', 'MYR', ${a.hq})`;
      await tx`insert into app.document_line (tenant_id, company_id, document_id, line_no, account_id, debit)
               values (${a.tenant}, ${a.company}, ${id}, 1, ${a.cash}, 25.0000)`;
      await tx`insert into app.document_line (tenant_id, company_id, document_id, line_no, account_id, credit)
               values (${a.tenant}, ${a.company}, ${id}, 2, ${a.sales}, 25.0000)`;
    });
    return id;
  };

  beforeAll(async () => {
    db = await startDb();
    a = await seedTenantV2(db, "Alpha");
    await grantCodes(db, a, { codes: ["accounting.journal.post"] });
    supervisor = await person("supervisor");
    await db.migrator`insert into app.permission (code, module, mutating, description)
      values ('accounting.credit_limit.override', 'accounting', true, 'test-local stand-in for 4A''s code')
      on conflict (code) do nothing`;
    await grantCodes(db, a, {
      principalId: supervisor,
      codes: ["accounting.credit_limit.override"],
    });
  });
  afterAll(async () => {
    await db.stop();
  });

  it("moves draft → submitted and returns the event the trigger wrote", async () => {
    const d = await draft();
    const result = await prodWithTenant(db.rw, ctx(a), (tx) =>
      transitionDocument(tx, ctx(a), { documentId: d, to: "submitted", reason: "for review" }),
    );
    expect(result).toMatchObject({ documentId: d, from: "draft", to: "submitted" });
    expect(result.eventId).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.number).toBeUndefined();
    const events = await prodWithTenant(db.rw, ctx(a), (tx) => listDocumentEvents(tx, d));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventKind: "transition",
      fromStatus: "draft",
      toStatus: "submitted",
      reason: "for review",
      actorId: a.human,
    });
  });

  it("to: 'issued' delegates to issueDocument and returns the number (contracts §4.3.1)", async () => {
    const d = await draft();
    const result = await prodWithTenant(db.rw, ctx(a), (tx) =>
      transitionDocument(tx, ctx(a), { documentId: d, to: "issued" }),
    );
    expect(result.from).toBe("draft");
    expect(result.to).toBe("issued");
    expect(typeof result.number).toBe("bigint");
    const [row] = await prodWithTenant(
      db.rw,
      ctx(a),
      (tx) => tx<{ number: string; series: string }[]>`
        select number::text as number, series from app.document where id = ${d}`,
    );
    expect(row!.number).toBe(String(result.number));
    expect(row!.series).toBe("JV");
  });

  it("carries attributedTo onto the event and clears both settings afterwards", async () => {
    const d = await draft();
    await prodWithTenant(db.rw, ctx(a), async (tx) => {
      await transitionDocument(tx, ctx(a), {
        documentId: d,
        to: "submitted",
        reason: "till",
        attributedTo: supervisor,
      });
      // a second, plain transition in the SAME transaction must not inherit the first one's reason
      await transitionDocument(tx, ctx(a), { documentId: d, to: "draft", reason: "recalculate" });
      await tx`update app.document set status = 'submitted' where id = ${d}`;
    });
    const events = await prodWithTenant(db.rw, ctx(a), (tx) => listDocumentEvents(tx, d));
    expect(events.map((e) => [e.toStatus, e.reason, e.attributedTo])).toEqual([
      ["submitted", "till", supervisor],
      ["draft", "recalculate", null],
      ["submitted", null, null],
    ]);
  });

  it("ERR_NOT_FOUND for a document the caller cannot see", async () => {
    const ghost = await uuidv7(db.admin);
    await expect(
      prodWithTenant(db.rw, ctx(a), (tx) =>
        transitionDocument(tx, ctx(a), { documentId: ghost, to: "submitted" }),
      ),
    ).rejects.toMatchObject({ code: "ERR_NOT_FOUND" });
  });

  it("recordOverride writes an override event for a second principal, and refuses the creator", async () => {
    const d = await draft();
    const { eventId } = await prodWithTenant(db.rw, ctx(a, supervisor), (tx) =>
      recordOverride(tx, ctx(a, supervisor), {
        documentId: d,
        code: "accounting.credit_limit.override",
        reason: "customer is good for it",
      }),
    );
    const events = await prodWithTenant(db.rw, ctx(a), (tx) => listDocumentEvents(tx, d));
    expect(events).toEqual([
      {
        id: eventId,
        eventKind: "override",
        fromStatus: "draft",
        toStatus: "draft",
        overrideCode: "accounting.credit_limit.override",
        actorId: supervisor,
        attributedTo: null,
        occurredAt: expect.any(String),
        reason: "customer is good for it",
      },
    ]);

    await grantCodes(db, a, {
      codes: ["accounting.credit_limit.override"],
      roleCode: "self-override",
    });
    await expect(
      prodWithTenant(db.rw, ctx(a), (tx) =>
        recordOverride(tx, ctx(a), {
          documentId: d,
          code: "accounting.credit_limit.override",
          reason: "mine",
        }),
      ),
    ).rejects.toThrow(/ERR_OVERRIDE_NOT_AUTHORISED/);
  });

  it("voidDocument's event carries the void reason (spec:1745)", async () => {
    const d = await draft();
    await prodWithTenant(db.rw, ctx(a), (tx) => postDocument(tx, ctx(a), { documentId: d }));
    const second = await draft();
    await prodWithTenant(db.rw, ctx(a), async (tx) => {
      await transitionDocument(tx, ctx(a), { documentId: second, to: "issued" });
    });
    await prodWithTenant(db.rw, ctx(a), (tx) =>
      voidDocument(tx, ctx(a), { documentId: second, reason: "printer jam; reissued" }),
    );
    const events = await prodWithTenant(db.rw, ctx(a), (tx) => listDocumentEvents(tx, second));
    expect(events.at(-1)).toMatchObject({ toStatus: "void", reason: "printer jam; reissued" });
  });

  it("setEventContext is transaction-scoped: a new transaction starts with no reason", async () => {
    const d = await draft();
    await prodWithTenant(db.rw, ctx(a), (tx) => setEventContext(tx, { reason: "leaked?" }));
    await prodWithTenant(
      db.rw,
      ctx(a),
      (tx) => tx`update app.document set status = 'submitted' where id = ${d}`,
    );
    const events = await prodWithTenant(db.rw, ctx(a), (tx) => listDocumentEvents(tx, d));
    expect(events[0]!.reason).toBeNull();
  });
});
