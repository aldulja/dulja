import { beforeAll, describe, expect, it } from "vitest";
import {
  listDocumentEvents,
  postDocument,
  recordOverride,
  systemContext,
  withTenant,
} from "@dulja/db";
import {
  grantCodes,
  seedAccount,
  seedDocumentType,
  seedItem,
  seedTenantV2,
  seedWarehouse,
  uuidv7,
  type Db,
  type Seed,
} from "@dulja/db/test";
import { grantAdmin, problemOf, sharedApi } from "../support/api";
import {
  postInventoryDocument,
  recordingJobs,
  STOCK_RECEIPT_COST_POLICY,
} from "./support/post-inventory";
// Type-only, so no runtime edge and no `dependency-rule` question — §4.18 round 3 settles that a root
// `tests/**` file may import `apps/api/test/support/app.ts` for a TYPE and reaches `startApi()` itself only
// through 0B's memoised `sharedApi()`, which this file uses.
import type { StartedApi } from "../../apps/api/test/support/app";

/**
 * Part VI test 18 (spec:2436) — "Negative stock is rejected by the data layer regardless of session flags,
 * user attributes, or write path. Overrides are explicit and audited." LEGACY-048.
 *
 * The control is app.assert_stock_available, a BEFORE INSERT trigger on app.inventory_movement (migration
 * 0031). Nothing below reaches around it, because there is nothing to reach around: the check is not in a
 * handler, not in a service and not behind a flag.
 */
describe("test 18 — stock availability is refused by the data layer, by every path", () => {
  let api: StartedApi;
  let db: Db;
  let s: Seed;
  let itemId: string;
  let warehouseId: string;
  let typeId: string;
  let supervisor: string;

  const ctx = (actor?: string) => ({
    tenantId: s.tenant,
    actorId: actor ?? s.human,
    requestId: "test-18",
  });

  /** `warehouse: "line.warehouse"` so a line can name it: CreateDocumentBody carries no header warehouse in
   *  this slice (3D adds one when TRANSFER needs it). Two account legs balance the ledger, and the item line
   *  carries the stock. Until code review 3 (R4) the item line matched no ledger rule, and postDocument now
   *  refuses a movement no each_line rule accounts for, so it carries STOCK_ISSUE_COST_POLICY's pair — COGS
   *  debited, inventory credited, at `line.cost`. The stock control this suite proves runs at step 9,
   *  before any ledger row, and does not depend on either pair. */
  const ISSUE_POLICY = {
    version: 1,
    documentType: "STOCK_ISSUE_TEST",
    direction: "internal",
    requires: [],
    lines: [
      {
        for: "each_line",
        side: "debit",
        account: { from: "line.account" },
        amount: "line.debit",
        when: { "line.kind": "account" },
      },
      {
        for: "each_line",
        side: "credit",
        account: { from: "line.account" },
        amount: "line.credit",
        when: { "line.kind": "account" },
      },
      {
        for: "each_line",
        side: "debit",
        account: { from: "item.cogs_account" },
        amount: "line.cost",
        when: { "line.kind": "item" },
      },
      {
        for: "each_line",
        side: "credit",
        account: { from: "item.inventory_account" },
        amount: "line.cost",
        when: { "line.kind": "item" },
      },
    ],
    inventory: { effect: "issue", warehouse: "line.warehouse", costing: "consume_layers" },
    tax: { applies: false },
    numbering: { series: "SIT", assignAt: "issue" },
    reversal: { allowed: true, producesType: "STOCK_ISSUE_TEST" },
    approval: { required: false, approve: null, post: "accounting.journal.post" },
    fxRoundingAccount: { from: "company.fx_rounding_account_id" },
    dimensions: { required: [] },
  };

  beforeAll(async () => {
    // `sharedApi()` returns `{ api, a, b }` (0B, §4.17.1) — it is NOT a `StartedApi`, so it is destructured.
    // Its `a`/`b` are bare `seedTenant` seeds; this suite needs a V2 tenant with an approval-bearing policy,
    // so it seeds its own and leaves `a`/`b` untouched for the regression files that share the instance.
    ({ api } = await sharedApi());
    db = api.db;
    s = await seedTenantV2(db, "Test18");
    await seedAccount(db, s, { code: "1300", nameEn: "Inventory control", type: "asset" });
    await seedAccount(db, s, { code: "5000", nameEn: "Cost of goods sold", type: "expense" });
    await seedAccount(db, s, { code: "5900", nameEn: "Other operating expense", type: "expense" });
    await grantAdmin(api, s); // the caller of the API path
    await grantCodes(db, s, { codes: ["accounting.journal.post"] });
    typeId = await seedDocumentType(db, s, {
      code: "STOCK_ISSUE_TEST",
      module: "inventory",
      policy: ISSUE_POLICY,
    });
    ({ itemId } = await seedItem(db, s, { code: "SUGAR-1KG", trackLots: false }));
    warehouseId = await seedWarehouse(db, s, { code: "HQ-MAIN" });
    // A second principal for the override door, in 2B's `secondPrincipal` shape (plan0A:837). The id comes
    // from `uuidv7(db.admin)` and not from `crypto.randomUUID()`: AGENTS.md's "Always" list fixes UUIDv7 for
    // every identifier, and `packages/db/test/document-event.test.ts`'s own `secondPrincipal` — the shape
    // this copies — mints it the same way.
    supervisor = await uuidv7(db.admin);
    // The context is built from `s.system` rather than resolved through `systemContext`, because this
    // transaction runs as `app_migrator` and `app.resolve_principal`'s EXECUTE is granted to `app_rw` ONLY
    // (§4.1) — `systemContext` on the migrator handle is a `permission denied`, not a context. `Seed.system`
    // already holds the id that lookup would return (§4.1), and 2B's `secondPrincipal` passes `s.system` the
    // same way. The two `systemContext` calls further down stay: they run on `db.rw`, model the real job
    // path, and are `await`ed — §4.2.2 declares `Promise<TenantContext>`, so passing the promise is a
    // typecheck failure and, had it reached runtime, `ctx.tenantId` would have been `undefined`.
    const setupCtx = { tenantId: s.tenant, actorId: s.system, requestId: "test-18-setup" };
    await withTenant(db.migrator, setupCtx, async (tx) => {
      await tx`insert into app.principal (id, kind, auth_subject, display_name)
               values (${supervisor}, 'human', ${`stock-supervisor:${s.tenant}`}, 'Stock supervisor')`;
      await tx`insert into app.membership (tenant_id, principal_id) values (${s.tenant}, ${supervisor})`;
    });
    await grantCodes(db, s, {
      codes: ["inventory.negative_stock.override"],
      principalId: supervisor,
      roleCode: "stock-override",
    });
  });
  // No `afterAll` stopping the API: `sharedApi()` is memoised for the whole `tests` run and §4.18 round 3
  // states plainly that its consumers must not call `api.stop()` on it — the next file to import it would
  // get a dead container. Testcontainers' Ryuk reaps it on process exit (0B assumption 10).

  /** A draft STOCK_ISSUE_TEST for `quantity`, created through the API. Returns the document id.
   *  `item` defaults to the suite's item; the concurrency case passes its own so it cannot disturb — or be
   *  disturbed by — the stock_on_hand figures the cases above and below assert on `itemId`. */
  const draftIssue = async (quantity: string, item: string = itemId): Promise<string> => {
    const res = await api.request({
      method: "POST",
      path: `/v1/companies/${s.company}/documents`,
      as: s.human,
      body: {
        documentTypeCode: "STOCK_ISSUE_TEST",
        effectiveDate: "2026-01-15",
        currency: "MYR",
        branchId: s.hq,
        lines: [
          { lineNo: 1, kind: "account", accountId: s.sales, debit: "12.0000" },
          { lineNo: 2, kind: "account", accountId: s.cash, credit: "12.0000" },
          {
            lineNo: 3,
            kind: "item",
            itemId: item,
            warehouseId,
            quantity,
            unitPrice: "12.0000",
            amount: "12.0000",
          },
        ],
      },
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { id: string }).id;
  };

  it("PATH 1 — the API refuses it with a 422 problem naming the code", async () => {
    const id = await draftIssue("5.000000");
    const res = await api.request({
      method: "POST",
      path: `/v1/companies/${s.company}/documents/${id}/transitions`,
      as: s.human,
      body: { to: "posted" },
    });
    expect(res.status).toBe(422);
    const problem = await problemOf(res);
    expect(problem.code).toBe("ERR_STOCK_INSUFFICIENT");
    expect(problem.detail).toMatch(new RegExp(`item ${itemId}`));
    // The costing engine's wording, not the trigger's: since 3B, `applyMovements` computes every movement
    // through `costingEngine.cost()` BEFORE it inserts one (contracts §4.7.2 — compute first, write second),
    // and §4.7.1 makes an uncovered, un-overridden issue ERR_STOCK_INSUFFICIENT there. The trigger's own
    // "holds …, this movement needs …" refusal is what PATH 3's raw insert, with no engine in front, meets.
    expect(problem.detail).toMatch(/5\.000000 requested but only 0\.000000 remains/);
    // and the document did not post — it is still a DRAFT, and its series number was not consumed.
    // `postDocument` is ONE transaction (§4.3.2 runs steps 1–15 in the caller's tx, and §4.5.4 routes
    // `to: "posted"` straight into it), so the step-7 issue — `series`, `fiscal_period_id`, `number` and the
    // `document_series` counter bump — rolls back together with the step-9 refusal. Asserting "issued" here
    // would be asserting a state that cannot survive the 422; asserting the null number is the visible proof
    // that a refused post costs no number, which is what 2B's gapless guarantee needs.
    const [row] = await withTenant(
      db.rw,
      ctx(),
      (tx) => tx<{ status: string; number: string | null }[]>`
        select status::text as status, number::text as number from app.document where id = ${id}`,
    );
    expect(row!.status).toBe("draft");
    expect(row!.number).toBeNull();
  });

  it("PATH 2 — a job, as the tenant's SYSTEM principal, is refused identically", async () => {
    const id = await draftIssue("5.000000");
    // app.actor_has returns TRUE for the system principal unconditionally (§4.1, R8), so a control that
    // consulted authority at all would admit this write. It is refused, because the control consults stock.
    const jobCtx = await systemContext(db.rw, s.tenant, "job-run-1"); // async; resolved once, used twice
    await expect(
      withTenant(db.rw, jobCtx, (tx) => postDocument(tx, jobCtx, { documentId: id })),
    ).rejects.toThrow(/ERR_STOCK_INSUFFICIENT/);
  });

  it("PATH 3 — a raw app_rw insert, with no posting service at all, is refused by the trigger", async () => {
    const id = await draftIssue("5.000000");
    await expect(
      withTenant(
        db.rw,
        ctx(),
        (tx) => tx`
      insert into app.inventory_movement
        (tenant_id, company_id, document_id, line_no, movement_no, item_id, warehouse_id, lot_id, unit_id,
         quantity, value, effective_date, posting_seq)
      select app.current_tenant(), ${s.company}, ${id}, 3, 1, ${itemId}, ${warehouseId},
             l.id, i.base_unit_id, -5.000000, -60.0000, '2026-01-15', 1
        from app.item i join app.lot l on l.item_id = i.id and l.code = 'NONE'
       where i.id = ${itemId}`,
      ),
    ).rejects.toThrow(/ERR_STOCK_INSUFFICIENT/);
  });

  it("PATH 2b — two CONCURRENT posts of the same stock key cannot both succeed", async () => {
    // The clause "regardless of … write path" includes two of the same path at once. `assert_stock_available`
    // sums app.inventory_movement, and §4.3.2 step 1's `select … for update` serialises posters of ONE
    // DOCUMENT — so two different documents issuing the same (company, item, warehouse, lot) would, under
    // READ COMMITTED, both read the same committed sum, both satisfy the trigger and both commit. Stock goes
    // negative with no override event anywhere, which is test 18 falsified by concurrency rather than by a
    // bypass. `lockStockKeys`, taken by applyMovements before the insert, is what closes it (Task 8).
    const { itemId: raceItem } = await seedItem(db, s, { code: "SUGAR-RACE", trackLots: false });
    // Stage +5 with a REAL receipt through the posting service. Until 3B a raw receipt movement was enough,
    // because only the trigger read stock; since 3B the costing engine prices every issue from the open
    // `cost_layer` rows before any movement is inserted (§4.7.2), and a raw movement opens no layer — so T1
    // itself was refused, never signalled `t1Ready`, and the case hung instead of racing. A posted receipt
    // gives the trigger its movement and the engine its layer, and goes through the step-12 MERGE, so the
    // stock_on_hand assertion at the end is the projection's honest figure rather than an explained residue.
    const receiptType = await seedDocumentType(db, s, {
      code: "STOCK_RECEIPT_TEST",
      module: "inventory",
      policy: STOCK_RECEIPT_COST_POLICY,
    });
    await postInventoryDocument(db, s, {
      documentTypeId: receiptType,
      warehouseId,
      effectiveDate: "2026-01-10",
      jobs: recordingJobs(),
      lines: [{ itemId: raceItem, warehouseId, quantity: "5.000000", unitPrice: "12.0000" }],
    });

    const first = await draftIssue("5.000000", raceItem);
    const second = await draftIssue("5.000000", raceItem);
    const jobCtx = await systemContext(db.rw, s.tenant, "job-race");
    // Two open transactions need two connections; `createDb`'s default `max` is 4 (§4.2.2), so the pool is
    // large enough. If this case ever hangs instead of failing, that is the number to check first.
    //
    // Deterministic ordering, not a sleep race: T1 signals once its own postDocument has returned — so its
    // movement row is written and its stock locks are held — and only then is T2 started. T1 stays open on
    // `gate` until T2 has had its chance to reach the lock.
    let t1Ready!: () => void;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      t1Ready = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const t1 = withTenant(db.rw, jobCtx, async (tx) => {
      const result = await postDocument(tx, jobCtx, { documentId: first });
      t1Ready();
      await gate; // hold the transaction — and its advisory locks — open
      return result;
    });
    const t2 = ready.then(() =>
      withTenant(db.rw, jobCtx, (tx) => postDocument(tx, jobCtx, { documentId: second })),
    );
    // Let T2 block, then let T1 commit. Either order is correct once the locks exist: T2 waits and re-reads
    // 0 available, or T2 starts after the commit and reads 0 available. Without the locks T2 reads the
    // staged +5 (T1's −5 invisible) and both succeed, which is the red this case exists to see.
    //
    // T2 may stall at step 7 rather than at `pg_advisory_xact_lock`: issuing takes the document's
    // `document_series` counter row, which T1 holds uncommitted. That is a plain row wait, not a deadlock —
    // the two hold `for update` on different `app.document` rows and take the stock keys in sorted order —
    // and it produces the same single refusal. An executor watching where T2 blocks should expect either.
    await new Promise((resolve) => setTimeout(resolve, 100));
    release();

    const outcomes = await Promise.allSettled([t1, t2]);
    const refused = outcomes.filter((o) => o.status === "rejected");
    expect(refused).toHaveLength(1);
    expect(String((refused[0] as PromiseRejectedResult).reason)).toMatch(/ERR_STOCK_INSUFFICIENT/);
    // The movements now sum to exactly zero — +5 staged, −5 issued once — so the second issue is refused for
    // the right reason and no stock went negative.
    const [sum] = await withTenant(
      db.rw,
      ctx(),
      (tx) => tx<{ q: string }[]>`
      select coalesce(sum(quantity), 0)::text as q from app.inventory_movement
       where item_id = ${raceItem} and warehouse_id = ${warehouseId}`,
    );
    expect(sum!.q).toBe("0.000000");
    // stock_on_hand agrees: the staged +5 and the one admitted −5 both went through the step-12 MERGE, and
    // the refused post rolled back with its projection write.
    const [soh] = await withTenant(
      db.rw,
      ctx(),
      (tx) => tx<{ quantity: string }[]>`
      select quantity::text as quantity from app.stock_on_hand
       where item_id = ${raceItem} and warehouse_id = ${warehouseId}`,
    );
    expect(soh!.quantity).toBe("0.000000");
  });

  it("a session flag changes nothing — there is no flag to set (LEGACY-048's four bypasses)", async () => {
    const id = await draftIssue("5.000000");
    await expect(
      withTenant(db.rw, ctx(), async (tx) => {
        await tx`select set_config('app.allow_negative_stock', 'true', true)`;
        await tx`select set_config('app.skip_stock_check', 'true', true)`;
        return postDocument(tx, ctx(), { documentId: id });
      }),
    ).rejects.toThrow(/ERR_STOCK_INSUFFICIENT/);
    // Not "the flag was ignored" but "the flag is not a thing": no SQL in the repository reads either name.
    const { sourceFiles } = await import("../support/source");
    const readers = sourceFiles()
      .filter((f) => /allow_negative_stock|skip_stock_check/.test(f.text))
      .map((f) => f.path);
    expect(readers).toEqual([]);
  });

  it("a policy attribute changes nothing — allowNegative is read by no code (assumption 4)", async () => {
    await seedDocumentType(db, s, {
      code: "STOCK_ISSUE_TEST",
      policyVersion: 2,
      effectiveFrom: "2026-01-01",
      policy: { ...ISSUE_POLICY, inventory: { ...ISSUE_POLICY.inventory, allowNegative: true } },
    });
    const id = await draftIssue("5.000000");
    const res = await api.request({
      method: "POST",
      path: `/v1/companies/${s.company}/documents/${id}/transitions`,
      as: s.human,
      body: { to: "posted" },
    });
    expect(res.status).toBe(422);
    expect((await problemOf(res)).code).toBe("ERR_STOCK_INSUFFICIENT");
  });

  it("the ONE door: a second principal's override event, and the post then succeeds", async () => {
    const id = await draftIssue("5.000000");
    await withTenant(db.rw, ctx(supervisor), (tx) =>
      recordOverride(tx, ctx(supervisor), {
        documentId: id,
        code: "inventory.negative_stock.override",
        reason: "physical count pending",
      }),
    );
    const res = await api.request({
      method: "POST",
      path: `/v1/companies/${s.company}/documents/${id}/transitions`,
      as: s.human,
      body: { to: "posted" },
    });
    expect(res.status).toBe(200);
    const [soh] = await withTenant(
      db.rw,
      ctx(),
      (tx) => tx<{ quantity: string }[]>`
      select quantity::text as quantity from app.stock_on_hand
       where item_id = ${itemId} and warehouse_id = ${warehouseId}`,
    );
    expect(soh!.quantity).toBe("-5.000000"); // negative, and only through the door
  });

  it("the override is EXPLICIT and AUDITED — a named event, stamped, and append-only", async () => {
    // "Audited" is proved from the artefact that exists. `app.document_event` has NO audit trigger: §3.5.3's
    // register row marks it `already` in both AUDIT_EXEMPT and IMMUTABLE, §4.5.2's DDL calls only
    // attach_stamp('app.document_event', 'actor_id'), and Task 5's own quoted AUDIT_EXEMPT set contains
    // "document_event". So there is no app.audit_log row to count, and looking for one would be a test that
    // can only fail. The immutable, actor-stamped event row IS the audit record for this table — which is
    // exactly why the table is audit-exempt — so the assertions are on that row: it names the code, it names
    // the second principal (stamped by app.stamp_actor from app.current_actor(), never from a payload), it
    // carries the reason and an occurrence time, and it cannot be edited afterwards.
    const [doc] = await withTenant(
      db.rw,
      ctx(),
      (tx) => tx<{ id: string }[]>`
      select d.id from app.document d
       where d.document_type_id = ${typeId} and d.status = 'posted' order by d.number desc limit 1`,
    );
    const events = await withTenant(db.rw, ctx(), (tx) => listDocumentEvents(tx, doc!.id));
    const override = events.find((e) => e.eventKind === "override");
    expect(override).toMatchObject({
      overrideCode: "inventory.negative_stock.override",
      actorId: supervisor,
      reason: "physical count pending",
    });
    expect(override!.occurredAt).not.toBeNull();

    // Append-only, both ways it is enforced. `app_rw` has UPDATE revoked (§4.5.2), so it never reaches the
    // trigger at all — it is refused on privilege, one layer earlier.
    await expect(
      withTenant(
        db.rw,
        ctx(),
        (tx) => tx`
      update app.document_event set reason = 'rewritten' where id = ${override!.id}`,
      ),
    ).rejects.toThrow(/permission denied/);
    // And the role that DOES hold UPDATE meets `document_event_immutable`, which is the control itself.
    // Built directly, for the reason the `beforeAll` gives: `app_migrator` may not execute
    // `app.resolve_principal`, so `systemContext` on this handle would fail before the trigger could.
    const migratorCtx = { tenantId: s.tenant, actorId: s.system, requestId: "test-18-immutable" };
    await expect(
      withTenant(
        db.migrator,
        migratorCtx,
        (tx) => tx`
      update app.document_event set reason = 'rewritten' where id = ${override!.id}`,
      ),
    ).rejects.toThrow(/ERR_TABLE_IMMUTABLE/);
  });

  it("the override does not survive the document: the next document is refused again", async () => {
    const id = await draftIssue("1.000000");
    const res = await api.request({
      method: "POST",
      path: `/v1/companies/${s.company}/documents/${id}/transitions`,
      as: s.human,
      body: { to: "posted" },
    });
    expect(res.status).toBe(422);
    expect((await problemOf(res)).code).toBe("ERR_STOCK_INSUFFICIENT");
  });

  it("the override needs a SECOND principal: the creator's own is refused by 2B's guard", async () => {
    const id = await draftIssue("1.000000");
    await grantCodes(db, s, {
      codes: ["inventory.negative_stock.override"],
      roleCode: "self-stock-override",
    });
    await expect(
      withTenant(db.rw, ctx(), (tx) =>
        recordOverride(tx, ctx(), {
          documentId: id,
          code: "inventory.negative_stock.override",
          reason: "mine",
        }),
      ),
    ).rejects.toThrow(/ERR_OVERRIDE_NOT_AUTHORISED/);
  });

  it("a principal WITHOUT the code cannot record the override even as a second principal", async () => {
    const id = await draftIssue("1.000000");
    const stranger = await uuidv7(db.admin);
    // Same reason as the `beforeAll`: built from `s.system`, not resolved on the migrator handle.
    await withTenant(
      db.migrator,
      { tenantId: s.tenant, actorId: s.system, requestId: "test-18-stranger" },
      async (tx) => {
        await tx`insert into app.principal (id, kind, auth_subject, display_name)
               values (${stranger}, 'human', ${`stranger:${s.tenant}`}, 'Stranger')`;
        await tx`insert into app.membership (tenant_id, principal_id) values (${s.tenant}, ${stranger})`;
      },
    );
    await grantCodes(db, s, { principalId: stranger });
    await expect(
      withTenant(db.rw, ctx(stranger), (tx) =>
        recordOverride(tx, ctx(stranger), {
          documentId: id,
          code: "inventory.negative_stock.override",
          reason: "no authority",
        }),
      ),
    ).rejects.toThrow(/ERR_OVERRIDE_NOT_AUTHORISED/);
  });

  // ── Code review 2 (Phase 4), finding S4: the override approves the stock lines it was recorded against ──
  // spec:624 (LEGACY-048) "recording who overrode what". Until migration 0114 both consumers asked only whether
  // an override EXISTED on the document, so the creator could re-key the draft after the supervisor approved
  // it and post a shortfall nobody had seen. Each case below fails on e8df83b.

  /** POST …/transitions {to:"posted"} as the creator. */
  const postViaApi = (id: string) =>
    api.request({
      method: "POST",
      path: `/v1/companies/${s.company}/documents/${id}/transitions`,
      as: s.human,
      body: { to: "posted" },
    });

  const stockOnHand = async (): Promise<string> => {
    const [soh] = await withTenant(
      db.rw,
      ctx(),
      (tx) => tx<{ quantity: string }[]>`
      select quantity::text as quantity from app.stock_on_hand
       where item_id = ${itemId} and warehouse_id = ${warehouseId}`,
    );
    return soh!.quantity;
  };

  const overrideAs = (id: string, reason: string) =>
    withTenant(db.rw, ctx(supervisor), (tx) =>
      recordOverride(tx, ctx(supervisor), {
        documentId: id,
        code: "inventory.negative_stock.override",
        reason,
      }),
    );

  it("an override approved for one unit does not post the draft re-keyed to 1,000 (S4)", async () => {
    const before = await stockOnHand();
    const id = await draftIssue("1.000000");
    await overrideAs(id, "one unit short, count pending");
    const edit = await api.request({
      method: "PUT",
      path: `/v1/companies/${s.company}/documents/${id}/lines`,
      as: s.human,
      body: {
        lines: [
          { lineNo: 1, kind: "account", accountId: s.sales, debit: "12.0000" },
          { lineNo: 2, kind: "account", accountId: s.cash, credit: "12.0000" },
          {
            lineNo: 3,
            kind: "item",
            itemId,
            warehouseId,
            quantity: "1000.000000",
            unitPrice: "12.0000",
            amount: "12.0000",
          },
        ],
      },
    });
    expect(edit.status).toBe(200);

    const res = await postViaApi(id);
    expect(res.status).toBe(422);
    const problem = await problemOf(res);
    expect(problem.code).toBe("ERR_STOCK_INSUFFICIENT");
    expect(problem.detail).toMatch(/approved other stock lines .* record the override again/);
    expect(await stockOnHand()).toBe(before);

    // The event recorded WHAT it approved: the digest of the one-unit lines, which the edit no longer matches.
    const [event] = await withTenant(
      db.rw,
      ctx(),
      (tx) => tx<{ digest: string | null; now: string }[]>`
      select e.approved_stock_digest as digest, app.document_stock_digest(${id}) as now
        from app.document_event e
       where e.document_id = ${id} and e.event_kind = 'override'`,
    );
    expect(event!.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(event!.digest).not.toBe(event!.now);

    // The door still works: the supervisor approves the lines as they now stand, and the post goes through.
    await overrideAs(id, "1,000 units, re-approved after the edit");
    const again = await postViaApi(id);
    expect(again.status).toBe(200);
    const [expected] = await db.admin<{ q: string }[]>`
      select (${before}::numeric - 1000)::numeric(19,6)::text as q`;
    expect(await stockOnHand()).toBe(expected!.q);
  });

  it("the binding is the data layer's: a raw app_rw edit after the override is refused at post and at the trigger (S4)", async () => {
    const before = await stockOnHand();
    const id = await draftIssue("1.000000");
    await overrideAs(id, "one unit short");
    await withTenant(
      db.rw,
      ctx(),
      (tx) =>
        tx`update app.document_line set quantity = 50.000000 where document_id = ${id} and line_no = 3`,
    );
    const jobCtx = await systemContext(db.rw, s.tenant, "s4-job");
    await expect(
      withTenant(db.rw, jobCtx, (tx) => postDocument(tx, jobCtx, { documentId: id })),
    ).rejects.toThrow(/ERR_STOCK_INSUFFICIENT: .*record the override again/);
    // No posting service in front at all: the trigger asks the same question of the same digest.
    await expect(
      withTenant(
        db.rw,
        ctx(),
        (tx) => tx`
      insert into app.inventory_movement
        (tenant_id, company_id, document_id, line_no, movement_no, item_id, warehouse_id, lot_id, unit_id,
         quantity, value, effective_date, posting_seq)
      select app.current_tenant(), ${s.company}, ${id}, 3, 1, ${itemId}, ${warehouseId},
             l.id, i.base_unit_id, -50.000000, -600.0000, '2026-01-15', 1
        from app.item i join app.lot l on l.item_id = i.id and l.code = 'NONE'
       where i.id = ${itemId}`,
      ),
    ).rejects.toThrow(/ERR_STOCK_INSUFFICIENT: .*approved other stock lines/);
    expect(await stockOnHand()).toBe(before);
  });

  it("the digest is stamped by the database, never taken from the caller (S4, LEGACY-044)", async () => {
    const id = await draftIssue("1.000000");
    await withTenant(
      db.rw,
      ctx(supervisor),
      (tx) => tx`
      insert into app.document_event (tenant_id, company_id, document_id, event_kind, from_status, to_status,
                                      override_code, reason, approved_stock_digest)
      values (${s.tenant}, ${s.company}, ${id}, 'override', 'draft', 'draft',
              'inventory.negative_stock.override', 'forged', ${"f".repeat(64)})`,
    );
    const [event] = await withTenant(
      db.rw,
      ctx(),
      (tx) => tx<{ digest: string; now: string }[]>`
      select e.approved_stock_digest as digest, app.document_stock_digest(${id}) as now
        from app.document_event e
       where e.document_id = ${id} and e.event_kind = 'override'`,
    );
    expect(event!.digest).toBe(event!.now);
    expect(event!.digest).not.toBe("f".repeat(64));
  });

  it("a stock override on a document that has already posted approves nothing and is refused (S4)", async () => {
    const [posted] = await withTenant(
      db.rw,
      ctx(),
      (tx) => tx<{ id: string }[]>`
      select d.id from app.document d
       where d.document_type_id = ${typeId} and d.status = 'posted' order by d.number desc limit 1`,
    );
    await expect(overrideAs(posted!.id, "after the fact")).rejects.toThrow(
      /ERR_DOC_STATUS_ILLEGAL: document .* is posted; a negative-stock override is recorded before the document posts/,
    );
  });
});
