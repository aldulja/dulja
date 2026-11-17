import {
  computeDocumentTax,
  issueDocument,
  postDocument,
  recordOverride,
  transitionDocument,
  withTenant,
  type JobClient,
  type PostResult,
  type TenantContext,
} from "@dulja/db";
import {
  draftTypedDocument,
  grantCodes,
  uuidv7,
  type Db,
  type DraftLine,
  type Seed,
} from "@dulja/db/test";
import { secondPrincipal } from "./post-inventory";

/** One line of an AR/AP document. Every money and quantity value is a STRING (no-number-money, §3.7.5). */
export interface ArLine {
  lineNo?: number;
  taxCodeId?: string;
  kind: "item" | "account" | "text";
  itemId?: string;
  accountId?: string;
  description?: string;
  quantity?: string;
  unitPrice?: string;
  amount?: string;
  taxAmount?: string;
  totalInclTax?: string;
  /** A COPIED cost, as a conversion service writes it (§4.7.2) — base currency, a magnitude. */
  cost?: string;
  debit?: string;
  credit?: string;
  /** 4B, for an inventory line posted through 4B's `postFromPack` (a GOODS_RECEIPT, a DELIVERY_ORDER): passed
   *  straight to `draftTypedDocument`'s line, which already writes all three columns. */
  warehouseId?: string;
  lotId?: string;
  unitId?: string;
}

export interface PostArOptions {
  taxInclusive?: boolean;
  computeTax?: boolean;
  documentTypeId: string;
  series: string;
  effectiveDate?: string;
  partyId?: string;
  currency?: string;
  exchangeRate?: string;
  /** The provenance of `exchangeRate`, written to `document.rate_source` (plan0A:1787, LEGACY-012).
   *  Defaults to `"unit"` at rate 1.00000000 and `manual:<actorId>` otherwise — the two spellings that
   *  column's own comment gives, and the same rule `draftSettlement` applies (4A Task 10). */
  rateSource?: string;
  /** Pinned on the header after the draft, as a drafting service pins the party's term (LEGACY-013). Absent
   *  leaves the column as the draft wrote it (null); `null` writes null explicitly. */
  paymentTermId?: string | null;
  /** 4B. The HEADER warehouse, passed straight to `draftTypedDocument` — a policy that resolves
   *  `inventory.warehouse: "header.warehouse"` and `requires: ["warehouse"]` reads the document, not the line. */
  warehouseId?: string;
  /** 4B. Passed straight to `postDocument` (3B amendment A5); absent, the post runs with no job client, which
   *  is the input step 14's warn-and-skip branch is specified against. */
  jobs?: JobClient;
  lines: readonly ArLine[];
  /** For a `required` approval: submit as `s.human`, approve and post as a second principal (R1).
   *  Registered by 4A and NOT exercised by it (contracts §4.17.1): the first slice to pass it proves it. */
  twoPrincipal?: boolean;
  /** 4B. The codes the second principal holds when `twoPrincipal` is set. Absent, it is PAYMENT's pair plus
   *  `accounting.sales.post`, as 4A wrote it; 4B's `postFromPack` passes the pack policy's own
   *  `approval.approve`/`approval.post`, so an approval-required type that is not PAYMENT (3D's
   *  EXPIRY_WRITE_OFF) walks the same path under a checker holding exactly its codes. */
  checkerCodes?: readonly string[];
  /** Record `accounting.credit_limit.override`, attributed to a second principal, before issuing. */
  creditOverride?: boolean;
}

export interface PostArResult {
  documentId: string;
  number: bigint;
  /** 4B. `postDocument`'s own result — its `warnings`, `ledgerEntryIds` and `enqueuedJobIds` included. */
  result: PostResult;
  /** The posted ledger rows, ordered by account code and then by ledger line number. */
  ledger: { code: string; debit: string; credit: string }[];
}

/** The AR/AP codes `s.human` is granted once per `Seed`. `seedTenant` grants `s.human` nothing (§4.1) and
 *  2B's R2 evaluates the policy's `approval.post` INSIDE the posting transaction, so a posting test that
 *  forgot the grant would fail for the wrong reason. `accounting.payment.approve` is deliberately absent:
 *  R6 pairs it with `.create`, and the approver is the second principal below, never the maker. */
const MAKER_CODES = [
  "accounting.sales.post",
  "accounting.purchase.post",
  "accounting.receipt.create",
  "accounting.receipt.post",
  "accounting.payment.create",
  "accounting.payment.post",
] as const;

const granted = new WeakSet<Seed>();

/** One second principal per `(Seed, label)`, its role granted once. `grantCodes` writes the role under a
 *  fixed `roleCode` and `role_tenant_id_code_key` refuses a second insert, so an unmemoised grant would fail
 *  the SECOND time any caller passed the same option in one tenant. */
const principals = new WeakMap<Seed, Map<string, string>>();

async function grantedPrincipal(
  db: Db,
  s: Seed,
  label: string,
  codes: readonly string[],
): Promise<string> {
  const known = principals.get(s) ?? new Map<string, string>();
  principals.set(s, known);
  const hit = known.get(label);
  if (hit !== undefined) return hit;
  const principalId = await secondPrincipal(db, s, label);
  await grantCodes(db, s, { codes, principalId, roleCode: label });
  known.set(label, principalId);
  return principalId;
}

/** `draftTypedDocument`'s line: the `ArLine` less the three columns it does not write. */
function draftLine(line: ArLine): DraftLine {
  const { taxAmount: _tax, totalInclTax: _total, cost: _cost, ...draft } = line;
  return draft;
}

/**
 * §4.17.1, slice 4A. The AR/AP twin of 3B's `postInventoryDocument`. Drafts a typed document with account
 * and item lines through 3C's `draftTypedDocument`, writes the two derived money columns the drafting helper
 * does not (`tax_amount`, `total_incl_tax`) and the COPIED `cost` a conversion service would write, walks
 * the document through the REAL state machine and posts it through the REAL `postDocument`.
 *
 * It opens no period: `draftTypedDocument` pins the seed's January period and the posting service resolves
 * the real one from `effective_date`. A caller posting outside January calls 3B's `ensureOpenPeriods` first —
 * doing it here would silently reopen `seedTenant`'s closed and locked months for every caller.
 */
export async function postArDocument(db: Db, s: Seed, opts: PostArOptions): Promise<PostArResult> {
  const ctxFor = async (actorId: string): Promise<TenantContext> => ({
    tenantId: s.tenant,
    actorId,
    requestId: await uuidv7(db.admin),
  });

  if (!granted.has(s)) {
    await grantCodes(db, s, { codes: MAKER_CODES });
    granted.add(s);
  }

  const { documentId, lineIds } = await draftTypedDocument(db, s, {
    documentTypeId: opts.documentTypeId,
    series: opts.series,
    effectiveDate: opts.effectiveDate ?? "2026-01-15",
    ...(opts.currency === undefined ? {} : { currency: opts.currency }),
    ...(opts.exchangeRate === undefined ? {} : { exchangeRate: opts.exchangeRate }),
    ...(opts.partyId === undefined ? {} : { partyId: opts.partyId }),
    ...(opts.warehouseId === undefined ? {} : { warehouseId: opts.warehouseId }),
    branchId: s.hq,
    lines: opts.lines.map(draftLine),
  });

  // The two derived columns and the copied cost. `draftTypedDocument`'s DraftLine carries neither
  // total_incl_tax nor cost, and both are written by a service in production — the invoice service copies
  // the cost (§4.7.2) and computes total_incl_tax = amount + tax_amount. Written here in one statement per
  // line so the helper needs no second fixture.
  //
  // …and `rate_source`, for the same reason: `draftTypedDocument` writes `currency` and `exchange_rate`
  // and NOT the provenance column (3C's insert list), while every production writer in this slice sets or
  // copies it. A null `rate_source` on a posted document is the LEGACY-012 absence itself — a base figure
  // whose rate nobody can account for — so the helper supplies the same two spellings plan0A:1787's own
  // comment gives and `draftSettlement` uses: `unit` at rate 1.00000000, `manual:<actor>` otherwise.
  const rate = opts.exchangeRate ?? "1.00000000";
  const rateSource = opts.rateSource ?? (rate === "1.00000000" ? "unit" : `manual:${s.human}`);
  const makerCtx = await ctxFor(s.human);
  await withTenant(db.rw, makerCtx, async (tx) => {
    for (const [i, l] of opts.lines.entries()) {
      await tx`
        update app.document_line
           set tax_amount     = coalesce(${l.taxAmount ?? null}::numeric, tax_amount),
               total_incl_tax = coalesce(${l.totalInclTax ?? l.amount ?? null}::numeric, total_incl_tax),
               cost           = coalesce(${l.cost ?? null}::numeric, cost)
         where id = ${lineIds[i]!} and document_id = ${documentId}`;
    }
    await tx`update app.document set rate_source = ${rateSource} where id = ${documentId}`;
    if (opts.taxInclusive === true)
      await tx`update app.document set tax_inclusive = true where id = ${documentId}`;
    if (opts.computeTax === true) await computeDocumentTax(tx, makerCtx, documentId);
    if (opts.paymentTermId !== undefined) {
      await tx`update app.document set payment_term_id = ${opts.paymentTermId} where id = ${documentId}`;
    }
  });

  if (opts.creditOverride === true) {
    // `document_event.actor_id` defaults to `app.current_actor()`, which is the maker here, so the second
    // principal is the ATTRIBUTED one — the only shape `document_event_override_guard` admits from a single
    // session (§4.5.3; 3B's `postOverriddenIssue` states the same three facts).
    const director = await grantedPrincipal(db, s, "ar-credit-override", [
      "accounting.credit_limit.override",
    ]);
    await withTenant(db.rw, makerCtx, (tx) =>
      recordOverride(tx, makerCtx, {
        documentId,
        code: "accounting.credit_limit.override",
        reason: "approved by the credit committee",
        attributedTo: director,
      }),
    );
  }

  const postInput = { documentId, ...(opts.jobs === undefined ? {} : { jobs: opts.jobs }) };
  let result: PostResult;
  if (opts.twoPrincipal === true) {
    // One checker per distinct code set: `grantedPrincipal` memoises by label and writes the role under it.
    const checker =
      opts.checkerCodes === undefined
        ? await grantedPrincipal(db, s, "ar-checker", [
            "accounting.payment.approve",
            "accounting.payment.post",
            "accounting.sales.post",
          ])
        : await grantedPrincipal(
            db,
            s,
            `ar-checker:${[...new Set(opts.checkerCodes)].toSorted().join("+")}`,
            [...new Set(opts.checkerCodes)],
          );
    await withTenant(db.rw, makerCtx, (tx) =>
      transitionDocument(tx, makerCtx, { documentId, to: "submitted" }),
    );
    // The checker is a DIFFERENT session: R1 compares app.current_actor() against every `submitted` actor.
    const checkerCtx = await ctxFor(checker);
    result = await withTenant(db.rw, checkerCtx, async (tx) => {
      await transitionDocument(tx, checkerCtx, { documentId, to: "approved" });
      await issueDocument(tx, checkerCtx, { documentId });
      return postDocument(tx, checkerCtx, postInput);
    });
  } else {
    result = await withTenant(db.rw, makerCtx, async (tx) => {
      await issueDocument(tx, makerCtx, { documentId });
      return postDocument(tx, makerCtx, postInput);
    });
  }

  const ledger = await withTenant(
    db.rw,
    makerCtx,
    (tx) =>
      tx<{ code: string; debit: string; credit: string }[]>`
      select a.code, e.debit::text as debit, e.credit::text as credit
        from app.ledger_entry e
        join app.account a on a.id = e.account_id
       where e.document_id = ${documentId}
       order by a.code, e.line_no`,
  );
  return { documentId, number: result.number, result, ledger: [...ledger] };
}
