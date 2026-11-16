// tests/invariants/support/ar-ap.ts — contracts §4.17.1 (4B amendment 9, ratified early in round 4). Owner 4B.
//
// The AR/AP fixture every ageing, FX and reconciliation test in slice 4B starts from, and the one way those
// tests post a document of a seeded type BY CODE. Tasks 3, 4, 5, 7 and 12 import it.
//
// RELATIONSHIP to 4A's two helpers, which this file builds on rather than restating (hazard 9):
//  - `postArDocument` (tests/invariants/support/post-ar.ts, §4.17.1, 4A) drafts, writes the derived line
//    columns and `rate_source`, walks the state machine and posts. `postFromPack` DELEGATES to it: what this
//    file adds is the part 4A's helper has no room for — the type resolved from its CODE off the pack, the
//    approval path read from that same envelope, the party's term pinned as a drafting service pins it, and
//    `allocate`. `postArDocument` gained three pass-through members for it (`warehouseId`, `jobs`,
//    `checkerCodes`) and returns `postDocument`'s whole `PostResult`.
//  - `loadTypesFromPack` (packages/db/test/ar-ap/_support.ts, 4A) configures types through 1A's REAL
//    `loadDocumentTypes`. `seedTypeFromPack` delegates to it.
//
// `PACK_DIR` is NOT 4A's `PACK_ROOT`. 4A's is `fileURLToPath(new URL("../../seed/my", …))` — absolute, and
// WITHOUT a trailing separator (the plan expected the relative "seed/my"; the tree has the absolute form).
// This one is absolute WITH the trailing separator, because its consumers concatenate onto it
// (`${PACK_DIR}document-types/<CODE>.json`) or `join` it. Neither file imports the other's constant.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Money } from "@dulja/domain";
import {
  allocateSettlement,
  resolvePartyTerm,
  withTenant,
  type JobClient,
  type PostResult,
  type TenantContext,
} from "@dulja/db";
import {
  grantCodes,
  seedAccount,
  seedParty,
  seedPaymentTerm,
  uuidv7,
  type Db,
  type Seed,
} from "@dulja/db/test";
import { loadTypesFromPack } from "../../../packages/db/test/ar-ap/_support";
import { postArDocument, type ArLine } from "./post-ar";
import { ensureOpenPeriods } from "./post-inventory";

/**
 * The ONE definition of the seed pack's location in the test tier — an ABSOLUTE directory path with a
 * trailing separator, so `${PACK_DIR}document-types/X.json` and `join(PACK_DIR, "document-types")` both
 * resolve from any working directory. Exported because Task 4's exhaustiveness guard globs
 * `document-types/` from it.
 */
export const PACK_DIR = fileURLToPath(new URL("../../../packages/db/seed/my/", import.meta.url));

/** The §4.3.7 seed envelope, as far as this file reads it. */
export interface DocumentTypeEnvelope {
  code: string;
  nameEn: string;
  nameAr?: string;
  module: string;
  policyVersion: number;
  effectiveFrom: string;
  policy: unknown;
}

/**
 * The ONE read of a document-type envelope in this file. `seedTypeFromPack`, `packApproval` and
 * `postFromPack`'s series all read it, and all must see the same file.
 */
function readEnvelope(code: string): DocumentTypeEnvelope {
  const raw = readFileSync(`${PACK_DIR}document-types/${code}.json`, "utf8");
  const envelope = JSON.parse(raw) as DocumentTypeEnvelope;
  if (envelope.code !== code) {
    throw new Error(
      `seed pack file ${code}.json declares code ${envelope.code} (§4.3.7 forbids the mismatch)`,
    );
  }
  return envelope;
}

/** The ids of this company's document types, by code. */
async function typeIdOf(db: Db, s: Seed, code: string): Promise<string | undefined> {
  const [row] = await withTenant(
    db.rw,
    { tenantId: s.tenant, actorId: s.human, requestId: await uuidv7(db.admin) },
    (tx) => tx<{ id: string }[]>`
      select id::text as id from app.document_type where company_id = ${s.company} and code = ${code}`,
  );
  return row?.id;
}

/**
 * Configure a document type in a Testcontainers company from the SEED PACK's own envelope. 4A owns
 * SALES_INVOICE.json, RECEIPT.json and the other four; copying their policies into a constant here would
 * diverge silently the first time 4A edited one. The configuring is 4A's `loadTypesFromPack` — 1A's real
 * `loadDocumentTypes` over the whole directory, which is idempotent when the database already equals the pack
 * — so the type arrives exactly as `bun run seed` would put it there, names and module included.
 *
 * SELECT FIRST: `postFromPack` calls this on every post, and once a posted document pins a policy version
 * the loader refuses to rewrite that version if the file has since moved (LEGACY-013, ADR 0027). A type that is
 * already configured is therefore never reloaded.
 */
export async function seedTypeFromPack(db: Db, s: Seed, code: string): Promise<string> {
  readEnvelope(code);
  const existing = await typeIdOf(db, s, code);
  if (existing !== undefined) return existing;
  await loadTypesFromPack(db, s, [code]);
  const loaded = await typeIdOf(db, s, code);
  if (loaded === undefined) {
    throw new Error(`the seed pack's ${code} did not configure a type for company ${s.company}`);
  }
  return loaded;
}

/** The `approval` block of a pack envelope's policy — the three members §4.4.1 requires. */
export interface PackApproval {
  required: boolean;
  approve: string | null;
  post: string;
}

/**
 * Read `policy.approval` out of the pack file. `postFromPack` derives the state-machine path from THIS rather
 * than from a caller-supplied flag, so a call site cannot forget that a type needs approval — without it
 * 4A's PAYMENT and 3D's EXPIRY_WRITE_OFF never post (§4.5.1 admits `draft → issued` only when
 * `approval.required = false`, and §4.3.2 step 2 turns anything else into ERR_DOC_STATUS_ILLEGAL).
 */
export function packApproval(code: string): PackApproval {
  const { policy } = readEnvelope(code);
  const a = (policy as { approval?: Partial<PackApproval> } | null)?.approval;
  if (!a || typeof a.post !== "string") {
    throw new Error(`${code}.json declares no policy.approval.post — §4.4.1 requires it`);
  }
  return { required: a.required === true, approve: a.approve ?? null, post: a.post };
}

/** `policy.numbering.series` off the same envelope — what `issueDocument` numbers the document under. */
function packSeries(code: string): string {
  const { policy } = readEnvelope(code);
  const series = (policy as { numbering?: { series?: unknown } } | null)?.numbering?.series;
  if (typeof series !== "string") {
    throw new Error(`${code}.json declares no policy.numbering.series — §4.4.1 requires it`);
  }
  return series;
}

/**
 * The twelve accounts every AR/AP test in slice 4B touches, each with the slice that seeds it in production.
 * `seedAccount` is `on conflict (company_id, code) do nothing` followed by a select, so it is idempotent and
 * `4000`, which `seedTenant` already created, returns the existing id rather than colliding. `5920` is
 * deliberately absent: `seedTenantV2` created it and wired it to `company.fx_rounding_account_id`. `1150` is
 * absent unless OD-09 lands (Task 9 seeds it).
 *
 * The three inventory corridors exist because Task 4 posts three INVENTORY documents through `postFromPack`,
 * and each one's policy resolves an account by code that `seedTenantV2` does not create:
 *   GOODS_RECEIPT    → `{ code: "2150" }` and `{ code: "1300" }` (3C)
 *   DELIVERY_ORDER   → `{ code: "1250" }`                       (3D)
 *   EXPIRY_WRITE_OFF → `{ code: "5100" }`                       (3D's policy over 3C's account)
 */
const ACCOUNTS = [
  { code: "1100", nameEn: "Bank", type: "asset" }, // 0C
  { code: "1200", nameEn: "Trade receivables (AR control)", type: "asset" }, // 0C
  { code: "1250", nameEn: "Goods delivered not invoiced", type: "asset" }, // 3D
  { code: "1300", nameEn: "Inventory control", type: "asset" }, // 0C
  { code: "2100", nameEn: "Trade payables (AP control)", type: "liability" }, // 0C
  { code: "2150", nameEn: "Goods received not invoiced (GRNI)", type: "liability" }, // 3C
  { code: "4000", nameEn: "Sales", type: "income" }, // 0C
  { code: "4900", nameEn: "Foreign-exchange gain", type: "income" }, // 0C
  { code: "5000", nameEn: "Cost of goods sold", type: "expense" }, // 0C
  { code: "5100", nameEn: "Inventory write-off — expiry loss", type: "expense" }, // 3C
  { code: "5900", nameEn: "Other operating expense", type: "expense" }, // 0C
  { code: "5910", nameEn: "Foreign-exchange loss", type: "expense" }, // 0C
] as const;

/** Every 4A document type these tests post. The loader configures the WHOLE pack directory on the first
 *  call, so 3C's, 3D's and (from Task 5) FX_REVALUATION arrive with them; this list is what the fixture
 *  returns ids for. */
const TYPES = [
  "SALES_INVOICE",
  "SALES_CREDIT_NOTE",
  "PURCHASE_INVOICE",
  "PURCHASE_CREDIT_NOTE",
  "RECEIPT",
  "PAYMENT",
] as const;

/**
 * Every permission code the posting transaction evaluates for the types above and for Task 4's three
 * inventory documents. `seedTenant` grants `s.human` nothing (§4.1, pinned) and 2B's R2 reads
 * `policy.approval.post` INSIDE the posting transaction, so the grant is not optional. R6's incompatible
 * pairs are a role-seed rule, not a grant-time one; R1 — the runtime rule — is what `postFromPack`'s second
 * principal satisfies for an approval-required type.
 */
const CODES = [
  "accounting.journal.post",
  "accounting.sales.create",
  "accounting.sales.post",
  "accounting.purchase.create",
  "accounting.purchase.post",
  "accounting.receipt.create",
  "accounting.receipt.post",
  "accounting.payment.create",
  "accounting.payment.approve",
  "accounting.payment.post",
  "accounting.bank.reconcile",
  // 3C's and 3D's codes, for the three inventory documents Task 4's fixture posts.
  "inventory.receipt.create",
  "inventory.receipt.post",
  "inventory.transfer.create",
  "inventory.transfer.post",
  "inventory.adjustment.create",
  "inventory.adjustment.approve",
] as const;

export interface ArApFixture {
  documentTypeIds: Readonly<Record<string, string>>;
  accountIds: Readonly<Record<string, string>>;
  partyIds: { customer: string; vendor: string };
  termId: string;
}

/**
 * Open periods for 2025 and 2026 (3B's helper — Plan 0A opens only 2026-01, closes 2026-02 and LOCKS
 * 2026-03), the twelve accounts, a customer and a vendor on a 30-day term, every 4A type in the pack and the
 * seventeen permission codes — in one call. Every ageing, FX and reconciliation test starts here.
 *
 * It reopens THIS seed's periods, so a suite sharing one seed with another file (the regression tier's
 * `sharedDb`) seeds a tenant of its own before calling it.
 */
export async function arApFixture(db: Db, s: Seed): Promise<ArApFixture> {
  await ensureOpenPeriods(db, s, 2025);
  await ensureOpenPeriods(db, s, 2026);
  await grantCodes(db, s, { codes: CODES });

  const accountIds: Record<string, string> = {};
  for (const a of ACCOUNTS) accountIds[a.code] = await seedAccount(db, s, a);

  const termId = await seedPaymentTerm(db, s, { code: "N30", dueDays: 30 });
  const customer = await seedParty(db, s, {
    kind: "customer",
    code: "CUST-1",
    receivableAccountId: accountIds["1200"]!,
  });
  const vendor = await seedParty(db, s, {
    kind: "vendor",
    code: "VEND-1",
    payableAccountId: accountIds["2100"]!,
  });
  await withTenant(
    db.rw,
    { tenantId: s.tenant, actorId: s.human, requestId: await uuidv7(db.admin) },
    (tx) => tx`
      update app.party set payment_term_id = ${termId}
       where company_id = ${s.company} and id = any(${[customer, vendor]}::uuid[])`,
  );

  const documentTypeIds: Record<string, string> = {};
  for (const code of TYPES) documentTypeIds[code] = await seedTypeFromPack(db, s, code);

  return { documentTypeIds, accountIds, partyIds: { customer, vendor }, termId };
}

export interface PostFromPackOptions {
  taxInclusive?: boolean;
  computeTax?: boolean;
  /** A document-type code with a file in the seed pack's `document-types/`. */
  code: string;
  effectiveDate: string;
  partyId?: string;
  currency?: string;
  exchangeRate?: string;
  /** Defaults as 4A's `postArDocument` defaults it: `unit` at rate 1.00000000, `manual:<actor>` otherwise. */
  rateSource?: string;
  /**
   * HEADER warehouse. A type whose policy resolves `inventory.warehouse: "header.warehouse"` and declares
   * `requires: ["warehouse"]` — 3C's `GOODS_RECEIPT` and 3D's `DELIVERY_ORDER` both do — reads it off the
   * DOCUMENT, not off the line. Passed through `postArDocument` to 3C's `draftTypedDocument`.
   */
  warehouseId?: string;
  /**
   * Passed straight through to `postDocument` (3B amendment A5). Omit it and the post runs with no job client
   * at all, which is the state Task 4 Step 5's "warns and skips" case asserts; pass 3B's `recordingJobs()`
   * and step 14's enqueue becomes observable.
   */
  jobs?: JobClient;
  /**
   * 4A's `ArLine`: an AR/AP pack policy reads `line.amount` and `line.total_incl_tax` (the helper writes the
   * second from the first unless `totalInclTax` is given) and derives the control-account leg from the party,
   * so an account line names the revenue, expense or bank account only. A JOURNAL line carries debit/credit.
   */
  lines: readonly ArLine[];
  /** Allocations applied through 4A's `allocateSettlement` once the document has posted. `amount` is in the
   *  SETTLED document's currency; `settlementAmount`, in this document's, is required when the two differ
   *  (4B, ADR 0047 decision 9). The realised FX difference is NOT posted here — `postSettlementFxDifference`
   *  or `settleWithFx` does that. */
  allocate?: readonly { settledDocumentId: string; amount: Money; settlementAmount?: Money }[];
}

/**
 * Post one document of a seed-pack type by CODE: the type configured from the pack (`seedTypeFromPack`), the
 * party's CURRENT payment term pinned on the draft through 4A's `resolvePartyTerm` exactly as 4A's drafting
 * services pin it (LEGACY-013 — the ageing cuts on the pinned term), the series the pack's policy numbers under,
 * and the approval path the pack's policy declares; then 4A's `postArDocument` drafts, walks the REAL state
 * machine and posts through 1A's frozen `postDocument`.
 *
 * An approval-required type (PAYMENT, EXPIRY_WRITE_OFF) is submitted by `s.human` and approved, issued AND
 * posted by a second principal holding exactly the policy's `approve` and `post` codes — R1 is checked at
 * `issued → posted` too, so a post by the submitter would fail even with the approval done.
 *
 * `allocate` runs in a transaction of its own after the post, as the maker. That is where 4A's settlement
 * service could not put it either for an approval-required type (a PAYMENT cannot post in its drafter's
 * transaction), and `allocateSettlement` binds every document to `s.company` whichever principal calls it.
 */
export async function postFromPack(
  db: Db,
  s: Seed,
  opts: PostFromPackOptions,
): Promise<{ documentId: string; result: PostResult }> {
  const documentTypeId = await seedTypeFromPack(db, s, opts.code);
  const approval = packApproval(opts.code);
  const ctx = async (): Promise<TenantContext> => ({
    tenantId: s.tenant,
    actorId: s.human,
    requestId: await uuidv7(db.admin),
  });

  const partyId = opts.partyId;
  const paymentTermId =
    partyId === undefined
      ? undefined
      : await withTenant(db.rw, await ctx(), (tx) => resolvePartyTerm(tx, { partyId }));

  const posted = await postArDocument(db, s, {
    documentTypeId,
    ...(opts.taxInclusive === undefined ? {} : { taxInclusive: opts.taxInclusive }),
    ...(opts.computeTax === undefined ? {} : { computeTax: opts.computeTax }),
    series: packSeries(opts.code),
    effectiveDate: opts.effectiveDate,
    ...(partyId === undefined ? {} : { partyId }),
    ...(opts.currency === undefined ? {} : { currency: opts.currency }),
    ...(opts.exchangeRate === undefined ? {} : { exchangeRate: opts.exchangeRate }),
    ...(opts.rateSource === undefined ? {} : { rateSource: opts.rateSource }),
    ...(paymentTermId === undefined ? {} : { paymentTermId }),
    ...(opts.warehouseId === undefined ? {} : { warehouseId: opts.warehouseId }),
    ...(opts.jobs === undefined ? {} : { jobs: opts.jobs }),
    ...(approval.required
      ? { twoPrincipal: true, checkerCodes: [approval.approve ?? approval.post, approval.post] }
      : {}),
    lines: opts.lines,
  });

  if (opts.allocate !== undefined && opts.allocate.length > 0) {
    const lines = opts.allocate.map((a) => ({
      settledDocumentId: a.settledDocumentId,
      amount: a.amount,
      ...(a.settlementAmount === undefined ? {} : { settlementAmount: a.settlementAmount }),
    }));
    const allocCtx = await ctx();
    await withTenant(db.rw, allocCtx, (tx) =>
      allocateSettlement(tx, allocCtx, {
        companyId: s.company,
        settlementDocumentId: posted.documentId,
        lines,
      }),
    );
  }
  return { documentId: posted.documentId, result: posted.result };
}
