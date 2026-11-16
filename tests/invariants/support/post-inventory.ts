import {
  postDocument,
  recordOverride,
  withTenant,
  type PostResult,
  type TenantContext,
} from "@dulja/db";
import { grantCodes, uuidv7, type Db, type Seed } from "@dulja/db/test";
import type { EnqueueOptions, JobClient, JobEnvelope, JobName, JobPayload } from "@dulja/db";
import type { Sql } from "postgres";

export interface InventoryLine {
  itemId: string;
  warehouseId: string;
  /** A MAGNITUDE at 6 dp — the policy's `inventory.effect` carries the direction (3A assumption 2). */
  quantity: string;
  unitPrice: string;
  lotId?: string | null;
  unitId?: string;
  accountId?: string | null;
}

export interface PostInventoryOptions {
  readonly documentTypeId: string;
  readonly lines: readonly InventoryLine[];
  readonly effectiveDate?: string;
  readonly warehouseId?: string | null;
  readonly toWarehouseId?: string | null;
  readonly currency?: string;
  readonly branchId?: string;
  readonly jobs?: JobClient;
  readonly actorId?: string;
  readonly beforePost?: (tx: Sql, documentId: string) => Promise<unknown>;
}

export interface RecordedJob {
  name: JobName;
  payload: unknown;
  singletonKey: string | undefined;
}

/**
 * Records instead of enqueueing. `postDocument`'s step 14 needs a `JobClient` (amendment A5) and a
 * Testcontainers database has no pg-boss installation, so a DB-tier test hands it this. `apps/worker`
 * tests use `startWorker().jobs`, which is real (§4.17.1).
 */
export function recordingJobs(): JobClient & { readonly enqueued: readonly RecordedJob[] } {
  const enqueued: RecordedJob[] = [];
  return {
    enqueued,
    async enqueue<N extends JobName>(
      _tx: Sql,
      name: N,
      job: JobEnvelope<JobPayload[N]>,
      opts?: EnqueueOptions,
    ) {
      const id = `recorded-${enqueued.length + 1}`;
      enqueued.push({ name, payload: job.payload, singletonKey: opts?.singletonKey });
      return id;
    },
  };
}

/**
 * Twelve OPEN monthly periods for `year`. Plan 0A's `seedTenant` gives 2026-01 open, 2026-02 closed and
 * 2026-03 locked and nothing after (plan0A:1588-1591), and `app.fiscal_period` refuses an overlapping row,
 * so this REOPENS those three and inserts months 4-12. Idempotent, so every call site may call it.
 */
export async function ensureOpenPeriods(db: Db, s: Seed, year: number): Promise<void> {
  await withTenant(
    db.migrator,
    { tenantId: s.tenant, actorId: s.system, requestId: await uuidv7(db.admin) },
    async (tx) => {
      await tx`
        update app.fiscal_period set status = 'open', reopen_reason = 'test fixture: ensureOpenPeriods'
         where company_id = ${s.company} and status <> 'open'
           and extract(year from starts_on) = ${year}`;
      for (let month = 1; month <= 12; month += 1) {
        const starts = `${year}-${String(month).padStart(2, "0")}-01`;
        await tx`
          insert into app.fiscal_period (tenant_id, company_id, starts_on, ends_on, status)
          select ${s.tenant}, ${s.company}, ${starts}::date,
                 (${starts}::date + interval '1 month' - interval '1 day')::date, 'open'
           where not exists (
             select 1 from app.fiscal_period
              where company_id = ${s.company}
                and starts_on <= (${starts}::date + interval '1 month' - interval '1 day')::date
                and ends_on   >= ${starts}::date)`;
      }
    },
  );
}

/**
 * Drafts an item-line document and posts it through the REAL `postDocument` — the only way a test in this
 * tier creates movements, layers or ledger rows (§4.17.1's rule for `postJournal`, applied to inventory).
 *
 * The insert list is `document_line`'s 1A base plus 2A's and 3A's additions (§4.3.4): `kind = 'item'`,
 * `item_id`, `quantity`, `unit_price`, `amount`, `warehouse_id`, `lot_id`, `unit_id`, `unit_quantity`.
 * `cost` is left NULL deliberately — filling it here would bypass the very hook under test.
 */
export async function postInventoryDocument(
  db: Db,
  s: Seed,
  opts: PostInventoryOptions,
): Promise<{ documentId: string; result: PostResult }> {
  const effectiveDate = opts.effectiveDate ?? "2026-02-01";
  await ensureOpenPeriods(db, s, Number(effectiveDate.slice(0, 4)));
  const ctx: TenantContext = {
    tenantId: s.tenant,
    actorId: opts.actorId ?? s.human,
    requestId: await uuidv7(db.admin),
  };
  return withTenant(db.rw, ctx, async (tx) => {
    const [header] = await tx<{ id: string }[]>`
      insert into app.document
        (tenant_id, company_id, document_type_id, series, effective_date, currency, branch_id, warehouse_id, to_warehouse_id)
      values (${s.tenant}, ${s.company}, ${opts.documentTypeId}, 'TMP',
              ${effectiveDate}, ${opts.currency ?? "MYR"},
              ${opts.branchId ?? s.hq}, ${opts.warehouseId ?? null}, ${opts.toWarehouseId ?? null})
      returning id::text as id`;
    const documentId = header!.id;

    let lineNo = 0;
    for (const line of opts.lines) {
      lineNo += 1;
      // amount = round(quantity × unit_price, 4) in DOCUMENT currency, computed by Postgres so no JavaScript
      // number touches money (`no-number-money`, §3.7.5). `cost` stays NULL — step 9 fills it.
      await tx`
        insert into app.document_line
          (tenant_id, company_id, document_id, line_no, kind, item_id, quantity, unit_price, amount,
           warehouse_id, lot_id, unit_id, unit_quantity, account_id, description)
        values (${s.tenant}, ${s.company}, ${documentId}, ${lineNo}, 'item', ${line.itemId},
                ${line.quantity}, ${line.unitPrice},
                round(${line.quantity}::numeric * ${line.unitPrice}::numeric, 4),
                ${line.warehouseId}, ${line.lotId ?? null}, ${line.unitId ?? null}, ${line.quantity},
                ${line.accountId ?? null}, ${`3B fixture line ${lineNo}`})`;
    }

    if (opts.beforePost) await opts.beforePost(tx, documentId);
    // `postDocument`'s input gains `jobs` in Task 7 (amendment A5's step 14); today's signature is
    // `{ documentId: string }`. The input is built as a VARIABLE rather than written as a fresh object
    // literal at the call site, because an excess-property check applies to a fresh literal only — so this
    // compiles against both signatures and the call reads identically once Task 7 lands.
    const input = { documentId, ...(opts.jobs === undefined ? {} : { jobs: opts.jobs }) };
    const result = await postDocument(tx, ctx, input);
    return { documentId, result };
  });
}

/** A second human principal in this tenant, created once per `(tenant, label)`. R8 (spec:2179) needs one:
 *  an override is a fact about a principal who is not the document's creator.
 *
 *  Exported by 3D (§4.17.1 amendment 12): Tasks 6, 8, 9 and 11 each need a second principal for an `override`
 *  event or an R1 approval, and `postOverriddenIssue` cannot serve them — it drafts no `party`, and
 *  DELIVERY_ORDER's policy carries `requires: ["party", …]`. Four file-local copies is the duplication
 *  hazard 9 forbids. One `export` keyword: no signature change, no body change. */
export async function secondPrincipal(db: Db, s: Seed, label: string): Promise<string> {
  const subject = `human:${label}:${s.tenant}`;
  const [existing] = await withTenant(
    db.migrator,
    { tenantId: s.tenant, actorId: s.system, requestId: await uuidv7(db.admin) },
    (tx) =>
      tx<
        { id: string }[]
      >`select id::text as id from app.principal where auth_subject = ${subject}`,
  );
  if (existing) return existing.id;
  const id = await uuidv7(db.admin);
  await withTenant(
    db.migrator,
    { tenantId: s.tenant, actorId: s.system, requestId: await uuidv7(db.admin) },
    async (tx) => {
      await tx`insert into app.principal (id, kind, auth_subject, display_name)
               values (${id}, 'human', ${subject}, ${label})`;
      await tx`insert into app.membership (tenant_id, principal_id) values (${s.tenant}, ${id})`;
    },
  );
  return id;
}

/**
 * An issue the open layers cannot cover, authorised the ONLY way F-6 admits: an `override` `document_event`
 * on the document, before it posts. **Three facts about `app.assert_override_authorised` (§4.5.3) determine
 * every line here, and each one refuses the obvious shape:**
 *
 * 1. The guard resolves `p := coalesce(new.attributed_to, new.actor_id)` and raises
 *    `ERR_OVERRIDE_NOT_AUTHORISED` when `p = document.created_by`. So the *document* is posted by `s.human`
 *    (the default) and the supervisor is the **attributed** principal — posting as the supervisor and
 *    attributing to them makes `p = created_by` and the insert is refused.
 * 2. `recordOverride` does not write `actor_id`; the column defaults to `app.current_actor()`, which inside
 *    one `withTenant` is the posting actor. A second *actor* is therefore impossible in a single
 *    transaction — which is why the second principal is the attributed one. That is exactly the shape
 *    §4.5.3 describes for POS ("attributed_to = the supervisor whose PIN authorised it").
 * 3. `app.principal_has(p, code, company, branch)` must hold for the attributed principal, so the
 *    supervisor gets its own role through `grantCodes({ principalId, roleCode })`.
 *
 * The event must exist when `app.assert_stock_available` fires, and that trigger fires *inside*
 * `postDocument` — which is the whole reason `beforePost` exists.
 */
export async function postOverriddenIssue(
  db: Db,
  s: Seed,
  opts: {
    documentTypeId: string;
    itemId: string;
    warehouseId: string;
    quantity: string;
    effectiveDate: string;
    unitPrice?: string;
  },
): Promise<{ documentId: string; result: PostResult; supervisorId: string }> {
  const supervisorId = await secondPrincipal(db, s, "sup");
  await grantCodes(db, s, {
    codes: ["inventory.negative_stock.override"],
    principalId: supervisorId,
    roleCode: "sup",
  });
  const { documentId, result } = await postInventoryDocument(db, s, {
    documentTypeId: opts.documentTypeId,
    warehouseId: opts.warehouseId,
    effectiveDate: opts.effectiveDate,
    jobs: recordingJobs(),
    lines: [
      {
        itemId: opts.itemId,
        warehouseId: opts.warehouseId,
        quantity: opts.quantity,
        unitPrice: opts.unitPrice ?? "50.0000",
      },
    ],
    beforePost: async (tx, id) =>
      recordOverride(
        tx,
        { tenantId: s.tenant, actorId: s.human, requestId: await uuidv7(db.admin) },
        {
          documentId: id,
          code: "inventory.negative_stock.override",
          reason: "authorised negative-stock excursion (3B fixture)",
          attributedTo: supervisorId,
        },
      ),
  });
  return { documentId, result, supervisorId };
}

/** The `each_line` pair every costing test needs: COGS debited and inventory credited, both at `line.cost`. */
export const STOCK_ISSUE_COST_POLICY = {
  version: 1,
  documentType: "STOCK_ISSUE_TEST",
  direction: "outbound",
  requires: [],
  lines: [
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
  // Its OWN type, like every §4.14 pack type: `reverseDocument` negates the line magnitudes and 3D's
  // `orientLeg` (ADR 0042) flips a negative-quantity leg to the opposite effect, so the reversal of an issue
  // is already a receipt. Naming STOCK_RECEIPT_TEST here — 3B's original fixture — flipped it twice, and a
  // reversed receipt put its goods back IN a second time (sah-004 saw 300 on hand after 100 + 100 − 100).
  reversal: { allowed: true, producesType: "STOCK_ISSUE_TEST" },
  approval: { required: false, approve: null, post: "accounting.journal.post" },
  fxRoundingAccount: { from: "company.fx_rounding_account_id" },
  dimensions: { required: [] },
} as const;

/** A receipt's ledger pair is inventory debited against `line.amount`. A purchase's real credit leg is 3C's
 *  GRNI and does not exist yet, so the fixture books the other side to **`5900` other operating expense**
 *  by CODE (§4.15, seeded by 0C and re-asserted by 3A's `seedItem`). It is addressed as `account.code` and
 *  **not** as `item.expense_account`, because §4.6.1 defaults `item.expense_account_id` only for
 *  `kind ∈ service | asset`, and a `product`, which every costing fixture uses, leaves it null and the policy
 *  would fail at post on an unresolvable account. The costing question is the debit. */
export const STOCK_RECEIPT_COST_POLICY = {
  version: 1,
  documentType: "STOCK_RECEIPT_TEST",
  direction: "inbound",
  requires: [],
  lines: [
    {
      for: "each_line",
      side: "debit",
      account: { from: "item.inventory_account" },
      amount: "line.amount",
      when: { "line.kind": "item" },
    },
    {
      for: "each_line",
      side: "credit",
      account: { code: "5900" },
      amount: "line.amount",
      when: { "line.kind": "item" },
    },
  ],
  inventory: { effect: "receipt", warehouse: "line.warehouse", costing: "create_layer" },
  tax: { applies: false },
  numbering: { series: "SRT", assignAt: "issue" },
  // Its own type, for the reason STOCK_ISSUE_COST_POLICY's `reversal` gives.
  reversal: { allowed: true, producesType: "STOCK_RECEIPT_TEST" },
  approval: { required: false, approve: null, post: "accounting.journal.post" },
  fxRoundingAccount: { from: "company.fx_rounding_account_id" },
  dimensions: { required: [] },
} as const;
