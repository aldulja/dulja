import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import type { Sql } from "postgres";
import { v7 as newUuidV7 } from "uuid";
import {
  AppError,
  ConvertDocumentBody,
  ConvertResultSchema,
  fromDatabaseError,
  PrintDocumentBody,
  ProblemSchema,
  UuidSchema,
} from "@dulja/contracts";
import {
  CreateDocumentBody,
  DeleteDocumentResultSchema,
  DocumentEventList,
  DocumentSchema,
  OverrideBody,
  OverrideResultSchema,
  ReplaceLinesBody,
  ReverseDocumentBody,
  ReverseDocumentResultSchema,
  TransitionBody,
  TransitionResultSchema,
} from "@dulja/contracts/accounting/document";
import {
  AllocateSettlementBody,
  AllocateSettlementResultSchema,
  AllocationList,
  AllocationQuery,
  AllocationSchema,
  OpenBalanceSchema,
  UnallocateBody,
} from "@dulja/contracts/accounting/allocation";
import {
  ConvertToInvoiceBody,
  ConvertToInvoiceResultSchema,
  CreditNoteBody,
  CreditNoteResultSchema,
} from "@dulja/contracts/accounting/invoice";
import {
  DraftSettlementBody,
  SettlementResultSchema,
} from "@dulja/contracts/accounting/settlement";
import { RevaluationResultSchema, RevalueBody } from "@dulja/contracts/accounting/fx";
import { PERMISSION, type PermissionCode } from "@dulja/contracts/permissions";
import {
  convertOrderToDelivery,
  convertToInvoice,
  creditNoteFrom,
  draftSettlement,
  issueDocument,
  listAllocations,
  listDocumentEvents,
  openBalance,
  computeDocumentTax,
  postDocument,
  postSettlementFxDifference,
  PrintError,
  recordOverride,
  renderDocumentSource,
  resolvePartyTerm,
  resolvePolicy,
  revalueAtPeriodEnd,
  reverseDocument,
  settlementControlViolation,
  settleWithFx,
  transitionDocument,
  unallocate,
  voidDocument,
  type AllocationRow,
  type OverrideCode,
} from "@dulja/db";
import { Money } from "@dulja/domain";
import type { AppEnv } from "../../context";
import {
  createDocumentLinks,
  createDocumentLinksRoute,
  getOpenQuantity,
  listDocumentLinks,
  listDocumentLinksRoute,
  openQuantityRoute,
} from "../../documents/link-handlers";
import { refuseServiceOnlyType } from "../../documents/service-only-type";
import {
  allocateLandedCostHandler,
  allocateLandedCostRoute,
  listLandedCostHandler,
  listLandedCostRoute,
} from "../../inventory/landed-cost-handlers";
import {
  countSheetHandler,
  countSheetRoute,
  readCountSheetHandler,
  readCountSheetRoute,
  recordCountsHandler,
  recordCountsRoute,
  transferReceiptHandler,
  transferReceiptRoute,
} from "../../inventory/count-handlers";
import { transferHandler, transferRoute } from "../../inventory/transfer-handlers";
import { requireDocumentModuleRead } from "../../middleware/require-attachment-read";
import {
  POLICY_RESOLVED_CODES,
  requireDocumentPermission,
  stageCode,
  type DocumentStage,
} from "../../middleware/require-document-permission";
import {
  assertRoleInCompany,
  markPermissionGate,
  requireAnyPermission,
  requirePermission,
} from "../../middleware/require-permission";
import { engineFor } from "../../print/engines";
import { IdempotencyHeader } from "../idempotency-header";

export const documentRoutes = new OpenAPIHono<AppEnv>({
  defaultHook: (result) => {
    if (!result.success) throw result.error;
  },
});

/** contracts §4.5.4. The union of every code any seeded type's policy may name at any stage. It cannot be
 *  derived from source — the code is resolved from data — so it is explicit, and every slice that seeds a
 *  document type adds its `approval.*` codes here in the same PR as its policy file. At 2A the only seeded
 *  type is JOURNAL (1A), and its policy names `accounting.journal.post` alone — it declares no
 *  `approval.create` (contracts §4.4.1, round-2 correction). `accounting.journal.create` stays in this
 *  constant because the static gate below was its only remaining source reference and §3.6.3's
 *  bidirectional `permission-catalogue` check needs one; it is still a catalogue code and still gated on
 *  this module. Initialised FROM `POLICY_RESOLVED_CODES`, never as a literal over the same line. */
export const DOCUMENT_STAGE_CODES: readonly PermissionCode[] = POLICY_RESOLVED_CODES;

/** 2A: the write gates are resolved from the effective policy (contracts §4.5.4, 1A T12 — "2A replaces both
 *  static gates"). Creating and editing a draft is the `create` stage; the transitions route maps `to`. */
const draft = requireDocumentPermission("create");

/**
 * `to` → the stage whose code the gate resolves (contracts §4.5.4): `draft` is "creating or editing the draft
 * itself", `submitted` is the submit stage, `approved` the approve stage, and the last three resolve
 * `approval.post`. `submitted → "submit"` rather than `"create"` even though `stageCode` returns the same code
 * for both (`approval.create ?? approval.post`): the six-member `DocumentStage` union exists so that a policy
 * schema that later separates the two has somewhere to land (2B).
 */
const STAGE_FOR: Record<z.infer<typeof TransitionBody>["to"], DocumentStage> = {
  draft: "create",
  submitted: "submit",
  approved: "approve",
  issued: "issue",
  posted: "post",
  void: "void",
};
/** The transitions gate: the stage — and so the code — comes from the body's `to` and the effective policy
 *  (contracts §4.5.4). Read before Zod runs; Hono caches the parsed body so the validator does not parse
 *  twice. An unknown `to` is refused HERE rather than handed on: a request that names no stage must never
 *  reach a handler ungated, however the validator would have answered. Marked as a gate over the same union,
 *  so `assertRouteGates` sees the route as gated. */
const transition = markPermissionGate(async (c, next) => {
  const { to } = (await c.req.json().catch(() => ({}))) as { to?: keyof typeof STAGE_FOR };
  const stage = to ? STAGE_FOR[to] : undefined;
  if (!stage) {
    throw new AppError(
      "ERR_VALIDATION_FAILED",
      `to must be one of ${Object.keys(STAGE_FOR).join(", ")}`,
    );
  }
  return requireDocumentPermission(stage)(c, next);
}, DOCUMENT_STAGE_CODES);
/** A document carries every line's account and amount, so its read is NOT membership-only the way the chart
 *  of accounts is: whoever drafts, posts or reads the ledger in THIS company may read it, and nobody else in
 *  the tenant may. `{ company: "path:companyId" }` 403s on the company, never on the document id, so no fact
 *  about the document leaks to a caller outside the company. 2C narrows this to the type's module read code
 *  (§4.5.8's MODULE_READ_CODE), of which `accounting.ledger.read` is the accounting row. */
/** §4.5.8's `hr` row (`MODULE_READ_CODE.hr`), asked IN ADDITION to `read` for an `hr` document (Phase 8 review). */
const HR_DOCUMENT_READ_CODE: PermissionCode = PERMISSION["hr.payroll.read"];
const read = requireAnyPermission(
  [
    PERMISSION["accounting.journal.create"],
    PERMISSION["accounting.journal.post"],
    PERMISSION["accounting.ledger.read"],
  ],
  { company: "path:companyId" },
);

type DocumentStatus =
  | "draft"
  | "submitted"
  | "approved"
  | "issued"
  | "void"
  | "posted"
  | "reversed";
interface HeaderRow {
  id: string;
  document_type_code: string;
  status: DocumentStatus;
  series: string;
  number: string | null;
  fiscal_period_id: string | null;
  effective_date: string;
  currency: string;
  exchange_rate: string;
  rate_source: string | null;
  branch_id: string;
  party_id: string | null;
  tax_inclusive: boolean;
  client_ref: string | null;
  reverses_document_id: string | null;
  posted_at: Date | null;
  created_at: Date;
  // 4A / migration 0045 — the pinned term, and the due date app.payment_due_date derives from it.
  payment_term_id: string | null;
  due_date: string | null;
}
interface LineRow {
  id: string;
  line_no: number;
  description: string | null;
  account_id: string | null;
  kind: string;
  debit: string;
  credit: string;
  item_id: string | null;
  quantity: string | null;
  unit_price: string | null;
  discount: string;
  amount: string;
  tax_code_id: string | null;
  tax_amount: string;
  total_incl_tax: string;
  cost: string | null;
  // 3A / migration 0032 — contracts §4.3.4's 3A row. `unit_id`/`unit_quantity` are the entered pair from
  // which app.document_line_base_quantity() derives `quantity` in the item's base unit (spec:2043).
  warehouse_id: string | null;
  lot_id: string | null;
  unit_id: string | null;
  unit_quantity: string | null;
  // 3D / migration 0040 — contracts §4.3.4's 3D row. Only a STOCK_COUNT or TRANSFER_RECEIPT line carries
  // them; on such a line `quantity` is the signed variance (counted - expected), never a stored third
  // number (LEGACY-018).
  counted_quantity: string | null;
  expected_quantity: string | null;
  dimensions: Record<string, string>;
  custom_fields: Record<string, unknown>;
}
/** Nested postgres.js fragments, never `sql.unsafe` — contracts §3.3 confines that to three homes. */
const header = (tx: Sql) =>
  tx`d.id, t.code as document_type_code, d.status::text as status, d.series, d.number::text as number,
     d.fiscal_period_id, to_char(d.effective_date, 'YYYY-MM-DD') as effective_date, d.currency,
     d.exchange_rate::text as exchange_rate, d.rate_source, d.branch_id, d.party_id, d.tax_inclusive, d.client_ref::text as client_ref,
     d.reverses_document_id, d.posted_at, d.created_at, d.payment_term_id,
     to_char(app.payment_due_date(d.payment_term_id, d.effective_date), 'YYYY-MM-DD') as due_date`;
const lineColumns = (tx: Sql) =>
  tx`id, line_no, description, account_id, kind, debit::text as debit, credit::text as credit,
     item_id, quantity::text as quantity, unit_price::text as unit_price, discount::text as discount,
     amount::text as amount, tax_code_id, tax_amount::text as tax_amount,
     total_incl_tax::text as total_incl_tax, cost::text as cost,
     warehouse_id, lot_id, unit_id, unit_quantity::text as unit_quantity,
     counted_quantity::text as counted_quantity, expected_quantity::text as expected_quantity,
     dimensions, custom_fields`;

const toDocument = (head: HeaderRow, lines: LineRow[]) => ({
  id: head.id,
  documentTypeCode: head.document_type_code,
  status: head.status,
  series: head.series,
  number: head.number,
  fiscalPeriodId: head.fiscal_period_id,
  effectiveDate: head.effective_date,
  currency: head.currency,
  exchangeRate: head.exchange_rate,
  rateSource: head.rate_source,
  branchId: head.branch_id,
  partyId: head.party_id,
  taxInclusive: head.tax_inclusive,
  clientRef: head.client_ref,
  reversesDocumentId: head.reverses_document_id,
  postedAt: head.posted_at?.toISOString() ?? null,
  createdAt: head.created_at.toISOString(),
  // 4A: derived in SQL (§4.8.2), never here — no JavaScript date arithmetic reaches an accounting date.
  paymentTermId: head.payment_term_id,
  dueDate: head.due_date,
  lines: lines.map((line) => ({
    id: line.id,
    lineNo: line.line_no,
    description: line.description,
    accountId: line.account_id,
    kind: line.kind as "account" | "item" | "tax" | "text" | "tender" | "payroll",
    debit: line.debit,
    credit: line.credit,
    itemId: line.item_id,
    quantity: line.quantity,
    unitPrice: line.unit_price,
    discount: line.discount,
    amount: line.amount,
    taxCodeId: line.tax_code_id,
    taxAmount: line.tax_amount,
    totalInclTax: line.total_incl_tax,
    cost: line.cost,
    warehouseId: line.warehouse_id,
    lotId: line.lot_id,
    unitId: line.unit_id,
    unitQuantity: line.unit_quantity,
    countedQuantity: line.counted_quantity,
    expectedQuantity: line.expected_quantity,
    dimensions: line.dimensions,
    customFields: line.custom_fields,
  })),
});

documentRoutes.openapi(
  createRoute({
    method: "post",
    path: "/",
    tags: ["accounting"],
    middleware: [draft] as const,
    summary: "Draft a document with its lines",
    request: {
      params: z.object({ companyId: UuidSchema }),
      headers: IdempotencyHeader,
      body: { content: { "application/json": { schema: CreateDocumentBody } } },
    },
    responses: {
      201: {
        description: "The draft",
        content: { "application/json": { schema: DocumentSchema } },
      },
      400: {
        description:
          "Invalid body; a type only its own service drafts (FX_REVALUATION: POST …/documents/revaluations and the allocation routes); or a settlement type whose party's open items are on its other control account (a refund, which has no posting rule)",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
      404: {
        description: "No such document type or company",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
      422: {
        description: "No rate, or no policy",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
    },
  }),
  async (c) => {
    const { companyId } = c.req.valid("param");
    const body = c.req.valid("json");
    const id = newUuidV7();
    refuseServiceOnlyType(body.documentTypeCode);
    const doc = await c.var.withTenant(async (tx) => {
      const [type] = await tx<{ id: string }[]>`
        select id from app.document_type
         where company_id = ${companyId} and code = ${body.documentTypeCode} and archived_at is null`;
      if (!type) {
        throw new AppError(
          "ERR_NOT_FOUND",
          `company ${companyId} has no document type ${body.documentTypeCode}`,
        );
      }

      const [company] = await tx<{ base_currency: string }[]>`
        select base_currency from app.company where id = ${companyId}`;
      if (!company) throw new AppError("ERR_NOT_FOUND", `no company ${companyId} in this tenant`);

      // The rate is pinned on the document at create; a stored base amount is never recomputed on read
      // (spec:2041, 2039). The identity pair is never looked up — it is rate 1, source 'unit' (§4.2.10).
      let rate = "1";
      let source: string | null = null;
      if (body.currency !== company.base_currency.trim()) {
        const [resolved] = await tx<{ rate: string | null; source: string | null }[]>`
          select rate::text as rate, source
            from app.rate_for(${companyId}, ${body.currency}, ${company.base_currency}, ${body.effectiveDate}::date)`;
        if (!resolved?.rate) {
          throw new AppError(
            "ERR_RATE_NOT_FOUND",
            // Written without the word "from": no-sql-concat scans untagged templates for SQL keywords and
            // a message that says "rate from X to Y" reads to it as a constructed query.
            `no exchange rate ${body.currency} → ${company.base_currency} for company ${companyId} on ${body.effectiveDate}`,
          );
        }
        rate = resolved.rate;
        source = resolved.source;
      }

      // The FK on document.branch_id is (tenant_id, branch_id): it admits any dimension_value in the tenant,
      // including a branch of ANOTHER company. The branch must be a live value of THIS company's BRANCH type.
      await assertBranchBelongs(tx, companyId, body.branchId);
      // Likewise document_party_fk (0018) is tenant-composite: a party of a SIBLING company would be accepted
      // by the schema, and loadSnapshot would then resolve `party.receivable_account` to that company's
      // account and post this company's document into it. The party must be a live party of THIS company.
      if (body.partyId !== undefined) await assertPartyBelongs(tx, companyId, body.partyId);
      // The party's CURRENT payment term, pinned at draft and never re-read (LEGACY-013) — through the one reader
      // of party.payment_term_id, as convertToInvoice and draftSettlement pin it (code review 2026-09-29: a
      // service invoice drafted here aged 1_30 the day after issue, and its due date was the effective date).
      // No route changes a draft's party, so the pin is taken here and nowhere else.
      const paymentTermId =
        body.partyId === undefined ? null : await resolvePartyTerm(tx, { partyId: body.partyId });

      // The series comes from the policy so a draft already shows the series it will be numbered in; the
      // number itself is assigned at issue and never by the client (LEGACY-051). resolvePolicy is the ONE
      // selection rule (greatest effective_from, highest version) and it parses the definition against the
      // schema on the way out, so a stale or hand-edited policy is refused here, not later at post.
      const { definition } = await resolvePolicy(tx, type.id, body.effectiveDate);
      const series = definition.numbering.series;
      // The refund refusal (code review 2, M5-X / F7) as a PRE-FLIGHT: a RECEIPT from a vendor or a PAYMENT to
      // a customer relieves an account that party's open items are not on, and postDocument step 6c — the
      // control — refuses it at post. Refused here too so no draft is written and no number is later spent
      // issuing one that can never post. No route changes a draft's party, so a check at create suffices.
      if (body.partyId !== undefined) {
        const violation = await settlementControlViolation(tx, definition, body.partyId);
        if (violation !== null) throw new AppError("ERR_VALIDATION_FAILED", violation);
      }

      // 2A: party_id. A uuid of another tenant raises 23503 on document_party_fk (migration 0018), which
      // fromDatabaseError maps to ERR_CONFLICT_REFERENCE (§4.2.4) — never a 500, and never a silent write.
      await tx`insert into app.document (id, tenant_id, company_id, document_type_id, series, effective_date,
                                         currency, exchange_rate, rate_source, branch_id, party_id, client_ref,
                                         payment_term_id, tax_inclusive)
               values (${id}, ${c.var.ctx.tenantId}, ${companyId}, ${type.id}, ${series},
                       ${body.effectiveDate}, ${body.currency}, ${rate}, ${source}, ${body.branchId},
                       ${body.partyId ?? null}, ${body.clientRef ?? null}, ${paymentTermId}, ${body.taxInclusive ?? false})`;
      await insertLines(tx, c.var.ctx.tenantId, companyId, id, body.lines);
      await computeDocumentTax(tx, c.var.ctx, id);
      return readDocument(tx, companyId, id);
    });
    return c.json(doc, 201);
  },
);

documentRoutes.openapi(
  createRoute({
    method: "get",
    path: "/{documentId}",
    tags: ["accounting"],
    middleware: [read] as const,
    summary:
      "Read a document with its lines (journal.create, journal.post or ledger.read in the company)",
    request: { params: z.object({ companyId: UuidSchema, documentId: UuidSchema }) },
    responses: {
      200: {
        description: "The document",
        content: { "application/json": { schema: DocumentSchema } },
      },
      403: {
        description: "No read authority in this company",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
      404: {
        description: "Not in this company",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
    },
  }),
  async (c) => {
    const { companyId, documentId } = c.req.valid("param");
    return c.json(
      await c.var.withTenant(async (tx) => {
        // Phase 8 review (test 32's endpoint channel): an `hr` document — a PAYROLL's per-employee lines, a
        // PAYROLL_PAYMENT's per-employee nets — is read under §4.5.8's `hr` row as well, at the document's branch,
        // as its print and events are. The three accounting codes above stay the gate for every other module.
        const [scope] = await tx<{ module: string; branchId: string | null }[]>`
          select dt.module::text as module, d.branch_id as "branchId"
            from app.document d join app.document_type dt on dt.id = d.document_type_id
           where d.id = ${documentId} and d.company_id = ${companyId}`;
        if (scope?.module === "hr") {
          const [ok] = await tx<{ ok: boolean }[]>`
            select app.actor_has(${HR_DOCUMENT_READ_CODE}, ${companyId}::uuid, ${scope.branchId}::uuid) as ok`;
          if (ok?.ok !== true) {
            throw new AppError(
              "ERR_RBAC_FORBIDDEN",
              `reading an 'hr' document needs ${HR_DOCUMENT_READ_CODE} at branch ${scope.branchId}`,
            );
          }
        }
        return readDocument(tx, companyId, documentId);
      }),
      200,
    );
  },
);

documentRoutes.openapi(
  createRoute({
    method: "put",
    path: "/{documentId}/lines",
    tags: ["accounting"],
    // Editing a draft is the same authority as creating one (contracts §4.5.4: "approval.create ??
    // approval.post … for creating or editing the draft itself").
    middleware: [draft] as const,
    summary: "Replace the lines of a draft",
    request: {
      params: z.object({ companyId: UuidSchema, documentId: UuidSchema }),
      headers: IdempotencyHeader,
      body: { content: { "application/json": { schema: ReplaceLinesBody } } },
    },
    responses: {
      200: {
        description: "The document",
        content: { "application/json": { schema: DocumentSchema } },
      },
      400: {
        description:
          "Invalid body, or a document of a type only its own service writes (FX_REVALUATION)",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
      404: {
        description: "Not in this company",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
      409: {
        description:
          "Not a draft; or a draft a service derived from another document — a conversion, whose lines are converts_to link targets (delete the draft and convert again), or a partial credit note, whose lines are returns link targets and whose reversesDocumentId is set (delete the draft and draft the credit note again)",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
    },
  }),
  async (c) => {
    const { companyId, documentId } = c.req.valid("param");
    const { lines } = c.req.valid("json");
    const doc = await c.var.withTenant(async (tx) => {
      const [existing] = await tx<
        { status: string; code: string; reversesDocumentId: string | null }[]
      >`
        select d.status::text as status, t.code, d.reverses_document_id as "reversesDocumentId"
          from app.document d join app.document_type t on t.id = d.document_type_id
         where d.id = ${documentId} and d.company_id = ${companyId}
           for update of d`;
      if (!existing) {
        throw new AppError("ERR_NOT_FOUND", `no document ${documentId} in company ${companyId}`);
      }
      refuseServiceOnlyType(existing.code);
      if (existing.status !== "draft") {
        throw new AppError(
          "ERR_DOC_STATUS_ILLEGAL",
          `document ${documentId} is ${existing.status}; only a draft's lines may be replaced`,
        );
      }
      // A draft a SERVICE derived from another document carries line-level links whose figures the service
      // computed against the source, and a residue rule sums them: a conversion (`converts_to`: 3D's order →
      // delivery, 4A's delivery/receipt → invoice) and a partial credit note `creditNoteFrom` drafted
      // (`returns`). The DELETE below would cascade those links away (0037: `target_line_id … on delete
      // cascade`), reopen the source, and let it be converted or credited a second time. Refused: the draft is
      // DELETED and drafted again by its service — a draft cannot be voided (0022 admits `void` from `issued`
      // only), and deleting it is 0037's other release path, which drops the links WITH the lines they priced.
      // `returns` alone does not make a draft derived: 3C's PURCHASE_RETURN is drafted and linked by the client
      // (contracts 4.3.1), no service derives it and no residue rule sums its links. The derived credit note is
      // told apart by its header — `creditNoteFrom` always names `reverses_document_id`, and a draft through
      // POST …/documents never can. Everything else — `fulfils`, `receives_against` and a client's `returns` —
      // is keyed by the client against an order, a dispatch or a receipt, and 0037 names this replacement as
      // its release path: the cascade drops those links and the client links the new lines
      // (document-transfer.test.ts replaces a TRANSFER_RECEIPT's lines; invoices.test.ts a PURCHASE_RETURN's).
      const kinds = new Set(
        (
          await tx<{ kind: string }[]>`
            select distinct link_kind::text as kind from app.document_link
             where target_document_id = ${documentId} and target_line_id is not null
               and link_kind in ('converts_to', 'returns')`
        ).map((r) => r.kind),
      );
      if (kinds.has("converts_to")) {
        throw new AppError(
          "ERR_DOC_STATUS_ILLEGAL",
          `document ${documentId} is a derived draft: its lines are converts_to link targets, and ` +
            "replacing them would drop those links and reopen the source — delete the draft and convert again",
        );
      }
      if (kinds.has("returns") && existing.reversesDocumentId !== null) {
        throw new AppError(
          "ERR_DOC_STATUS_ILLEGAL",
          `document ${documentId} is a derived credit note: its lines are returns link targets, and ` +
            "replacing them would drop those links and reopen the invoice it credits — " +
            "delete the draft and draft the credit note again",
        );
      }
      // A replacement DELETES every existing line and inserts the new set — a body of [1, 3] must not leave
      // line 2 standing. 1A had no DELETE grant on document_line and zeroed the rows into tombstones instead;
      // 2B's migration 0023 granted the DELETE (guarded by document_line_delete_draft_only, and this row is
      // locked as a draft above), and a tombstone was never harmless: loadSnapshot, the print model and
      // reverseDocument read every row of the document with no filter, so a zeroed line printed as an empty
      // row, counted in `totals.lineCount` and was copied onto the reversal. The AFTER DELETE `audit_row`
      // trigger keeps each removed row's before-image (spec:106).
      await tx`delete from app.document_line where document_id = ${documentId}`;
      await insertLines(tx, c.var.ctx.tenantId, companyId, documentId, lines);
      await computeDocumentTax(tx, c.var.ctx, documentId);
      return readDocument(tx, companyId, documentId);
    });
    return c.json(doc, 200);
  },
);

documentRoutes.openapi(
  createRoute({
    method: "post",
    path: "/{documentId}/transitions",
    tags: ["accounting"],
    // The stage — and so the code — comes from the body's `to` and the effective policy (contracts §4.5.4).
    // Read before Zod runs; Hono caches the parsed body so the validator does not parse twice.
    middleware: [transition] as const,
    summary: "Move a document through its lifecycle (reversal is its own route, §4.5.4)",
    request: {
      params: z.object({ companyId: UuidSchema, documentId: UuidSchema }),
      headers: IdempotencyHeader,
      body: { content: { "application/json": { schema: TransitionBody } } },
    },
    responses: {
      200: {
        description: "The outcome",
        content: { "application/json": { schema: TransitionResultSchema } },
      },
      400: {
        description:
          "Refused by the posting service's own validation (ERR_VALIDATION_FAILED): e.g. a line its policy does not account for, or a transfer leg at the wrong kind of warehouse",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
      404: {
        description: "Not in this company",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
      409: {
        description: "Illegal transition",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
      422: {
        description: "Unbalanced, closed period, or invalid policy",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
    },
  }),
  async (c) => {
    const { companyId, documentId } = c.req.valid("param");
    const body = c.req.valid("json");
    const result = await c.var.withTenant(async (tx) => {
      // ONE read, serving three purposes: it restores 1A's ownership check (the middleware matches on `id`
      // alone, so a document of a sibling company inside the same tenant must be refused here), it gives the
      // TRUE `from` status — contracts §4.3.2 step 2 lets postDocument accept a draft, submitted or approved
      // document and issue it in the same transaction, so `from` can be any of four values and hard-coding
      // "issued" would contradict the document_event rows the triggers wrote — and it locks the row for the
      // rest of the transaction, which is what postDocument's own `for update` would do a moment later.
      const [before] = await tx<{ status: DocumentStatus }[]>`
        select status::text as status from app.document
         where id = ${documentId} and company_id = ${companyId} for update`;
      if (!before) {
        throw new AppError("ERR_NOT_FOUND", `no document ${documentId} in company ${companyId}`);
      }
      const from = before.status;

      if (body.to === "posted") {
        const posted = await postDocument(tx, c.var.ctx, { documentId, jobs: c.var.jobs });
        return {
          documentId,
          from,
          to: "posted" as const,
          eventId: await lastEventId(tx, documentId),
          status: "posted",
          number: posted.number.toString(),
          series: posted.series,
          fiscalPeriodId: posted.fiscalPeriodId,
          ledgerEntryIds: posted.ledgerEntryIds,
        };
      }
      if (body.to === "void") {
        await voidDocument(tx, c.var.ctx, { documentId, reason: body.reason! });
        const head = await headerOf(tx, documentId);
        return {
          documentId,
          from,
          to: "void" as const,
          eventId: await lastEventId(tx, documentId),
          status: "void",
          number: head.number,
          series: head.series,
          fiscalPeriodId: head.fiscalPeriodId,
          ledgerEntryIds: [] as string[],
        };
      }
      // draft, submitted, approved, issued — transitionDocument; `issued` delegates to issueDocument inside
      // it, which owns the series lock and the numbering (contracts §4.3.6).
      const attributedTo = attributedPrincipal(c, body.attributedTo);
      const moved = await transitionDocument(tx, c.var.ctx, {
        documentId,
        to: body.to,
        ...(body.reason === undefined ? {} : { reason: body.reason }),
        ...(attributedTo === undefined ? {} : { attributedTo }),
      });
      const head = await headerOf(tx, documentId);
      return {
        documentId,
        from: moved.from,
        to: moved.to,
        eventId: moved.eventId,
        status: moved.to,
        number: head.number,
        series: head.series,
        fiscalPeriodId: head.fiscalPeriodId,
        ledgerEntryIds: [] as string[],
      };
    });
    return c.json(result, 200);
  },
);

/** The id of the transition event the AFTER trigger just wrote. uuidv7 is time-ordered, so `order by id desc`
 *  is insertion order — `occurred_at` cannot be, because now() is the transaction start (2B). */
async function lastEventId(tx: Sql, documentId: string): Promise<string> {
  const [row] = await tx<{ id: string }[]>`
    select id from app.document_event where document_id = ${documentId} and event_kind = 'transition'
     order by id desc limit 1`;
  return row!.id;
}

/** The three numbering members of TransitionResultSchema, read AFTER the transition. `number` is a bigint
 *  column and JSON has no bigint, so it is cast in SQL rather than converted in TypeScript. */
async function headerOf(
  tx: Sql,
  documentId: string,
): Promise<{ number: string | null; series: string; fiscalPeriodId: string | null }> {
  const [row] = await tx<
    { number: string | null; series: string; fiscal_period_id: string | null }[]
  >`
    select number::text as number, series, fiscal_period_id from app.document where id = ${documentId}`;
  return { number: row!.number, series: row!.series, fiscalPeriodId: row!.fiscal_period_id };
}

/** contracts §4.5.4. D13: the reversing document is created, posted and the original marked `reversed` in one
 *  transaction. The route's own gate is `accounting.document.reverse` **at the document's own branch** — a
 *  branch-restricted assignment must be able to reverse there, and `actor_has(code, company, null)` would
 *  refuse it (2B route decision 4). The *posting* of the reversing document is authorised separately by the
 *  status trigger against the reversal type's `approval.post`. */
documentRoutes.openapi(
  createRoute({
    method: "post",
    path: "/{documentId}/reverse",
    tags: ["accounting"],
    middleware: [
      requirePermission(PERMISSION["accounting.document.reverse"], {
        company: "path:companyId",
        branch: "document",
      }),
    ] as const,
    summary: "Reverse a posted document (D13)",
    request: {
      headers: IdempotencyHeader,
      params: z.object({ companyId: UuidSchema, documentId: UuidSchema }),
      body: { content: { "application/json": { schema: ReverseDocumentBody } } },
    },
    responses: {
      200: {
        description: "Reversed",
        content: { "application/json": { schema: ReverseDocumentResultSchema } },
      },
      404: {
        description: "Not found",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
      409: {
        description: "Not posted, or its policy forbids reversal",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
    },
  }),
  async (c) => {
    const { companyId, documentId } = c.req.valid("param");
    const body = c.req.valid("json");
    const result = await c.var.withTenant(async (tx) => {
      const [owned] = await tx<{ id: string }[]>`
        select id from app.document where id = ${documentId} and company_id = ${companyId}`;
      if (!owned) {
        throw new AppError("ERR_NOT_FOUND", `no document ${documentId} in company ${companyId}`);
      }
      return reverseDocument(tx, c.var.ctx, {
        documentId,
        effectiveDate: body.effectiveDate,
        reason: body.reason,
        jobs: c.var.jobs,
      });
    });
    return c.json(
      { reversalDocumentId: result.reversalDocumentId, number: result.number.toString() },
      200,
    );
  },
);

/** The three codes an override event may carry (contracts §4.3.1 `OverrideCode`). None is in the catalogue at
 *  2B — 3A, 4A and 6A seed them — so the gate below is marked over these literals rather than over
 *  `PERMISSION[…]` references; `isMutating` treats an unknown code as mutating and the boot check stays strict. */
const OVERRIDE_CODES: readonly OverrideCode[] = [
  "inventory.negative_stock.override",
  "accounting.credit_limit.override",
  "pos.ticket.override",
];

/**
 * spec:1324 confines `attributed_to` to ONE shape: a terminal acts and the supervisor whose PIN authorised
 * the action is attributed (6C verifies the PIN; hazard 19). A human or system caller IS the principal whose
 * authority is checked, and a body that names somebody else is refused rather than trusted — otherwise any
 * tenant member could record an override or a transition "by" any principal who holds the code, and the
 * audit-grade `document_event` would say that person authorised something they never saw (AGENTS.md: never
 * trust an actor identity supplied by a client). Returns the principal to attribute, or `undefined`.
 */
function attributedPrincipal(
  c: Parameters<MiddlewareHandler<AppEnv>>[0],
  attributedTo: string | null | undefined,
): string | undefined {
  if (attributedTo === undefined || attributedTo === null) return undefined;
  if (c.var.ctx.principalKind !== "terminal") {
    throw new AppError(
      "ERR_VALIDATION_FAILED",
      "attributedTo is accepted from a terminal principal only (spec:1324); a back-office caller is the second principal and names nobody else",
      {
        errors: [
          { path: "attributedTo", message: "not accepted from a human or system principal" },
        ],
      },
    );
  }
  return attributedTo;
}

/**
 * contracts §4.5.3. The gate is inline and not `requirePermission`: the code is a body value, and no
 * `OverrideCode` member is in the catalogue at 2B. The control is `document_event_override_guard`
 * (migration 0021), which demands a SECOND principal — this pre-flight only turns "you do not hold this code"
 * into a 403 with a remedy instead of a 409 from a trigger.
 *
 * It asks `principal_has` about the identical principal the guard resolves — the attributed supervisor when a
 * TERMINAL names one, otherwise the caller — so the two can never disagree about WHOSE authority was missing.
 * A human caller naming `attributedTo` is refused by `attributedPrincipal` before anything is asked.
 */
const overrideGate = markPermissionGate(async (c, next) => {
  const companyId = c.req.param("companyId")!;
  const documentId = c.req.param("documentId") ?? null;
  const body = (await c.req.json().catch(() => ({}))) as {
    code?: unknown;
    attributedTo?: unknown;
  };
  const code = typeof body.code === "string" ? body.code : "";
  const attributedTo =
    attributedPrincipal(c, typeof body.attributedTo === "string" ? body.attributedTo : null) ??
    null;
  await c.var.withTenant(async (tx) => {
    // S3 (code review 2): the company first. Read after the document, a caller with no role in the path
    // company got "does not hold … at branch <id>" for a real id and 404 for a random one.
    await assertRoleInCompany(tx, c.var.ctx.actorId, companyId);
    const [doc] = await tx<{ company_id: string; branch_id: string }[]>`
      select company_id, branch_id from app.document where id = ${documentId} and company_id = ${companyId}`;
    if (!doc) {
      throw new AppError("ERR_NOT_FOUND", `no document ${documentId} in company ${companyId}`);
    }
    // The principal whose authority the GUARD will check (contracts §4.5.3): the attributed supervisor when
    // the caller names one, otherwise the acting principal. Asking about any other principal here would
    // produce a 403 naming the wrong one.
    const bearer = attributedTo ?? c.var.ctx.actorId;
    const [allowed] = await tx<{ ok: boolean }[]>`
      select app.principal_has(${bearer}::uuid, ${code}, ${doc.company_id}, ${doc.branch_id}) as ok`;
    if (!allowed?.ok) {
      throw new AppError(
        "ERR_RBAC_FORBIDDEN",
        `principal ${bearer} does not hold ${code || "(no code given)"} at branch ${doc.branch_id}`,
      );
    }
  });
  await next();
}, OVERRIDE_CODES);

documentRoutes.openapi(
  createRoute({
    method: "post",
    path: "/{documentId}/overrides",
    tags: ["accounting"],
    middleware: [overrideGate] as const,
    summary: "Record an override by a second principal (R8)",
    request: {
      headers: IdempotencyHeader,
      params: z.object({ companyId: UuidSchema, documentId: UuidSchema }),
      body: { content: { "application/json": { schema: OverrideBody } } },
    },
    responses: {
      200: {
        description: "Recorded",
        content: { "application/json": { schema: OverrideResultSchema } },
      },
      403: {
        description: "Forbidden",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
      409: {
        description: "The guard refused: the override needs a second principal",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
    },
  }),
  async (c) => {
    const { documentId } = c.req.valid("param");
    const body = c.req.valid("json");
    const attributedTo = attributedPrincipal(c, body.attributedTo);
    const result = await c.var.withTenant((tx) =>
      recordOverride(tx, c.var.ctx, {
        documentId,
        code: body.code,
        reason: body.reason,
        ...(attributedTo === undefined ? {} : { attributedTo }),
      }),
    );
    return c.json(result, 200);
  },
);

/** contracts §4.5.4, ADR 0030. Drafts only — `document_delete_draft_only` (migration 0023) is the control and
 *  raises ERR_DOC_NOT_DRAFT; the AFTER DELETE `audit_row` trigger keeps the before-image (spec:2049). Gated
 *  as the `create` stage: deleting a draft is editing it to nothing (2B route decision 2). */
documentRoutes.openapi(
  createRoute({
    method: "delete",
    path: "/{documentId}",
    tags: ["accounting"],
    middleware: [draft] as const,
    summary: "Delete a draft",
    request: {
      headers: IdempotencyHeader,
      params: z.object({ companyId: UuidSchema, documentId: UuidSchema }),
    },
    responses: {
      200: {
        description: "Deleted",
        content: { "application/json": { schema: DeleteDocumentResultSchema } },
      },
      409: {
        description: "Not a draft",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
    },
  }),
  async (c) => {
    const { companyId, documentId } = c.req.valid("param");
    await c.var.withTenant(async (tx) => {
      const rows =
        await tx`delete from app.document where id = ${documentId} and company_id = ${companyId}`;
      if (rows.count === 0) {
        throw new AppError("ERR_NOT_FOUND", `no document ${documentId} in company ${companyId}`);
      }
    });
    return c.json({ documentId, deleted: true as const }, 200);
  },
);

/**
 * contracts §4.5.4: "membership + the type's module read code" — the §4.5.8 map in
 * `require-attachment-read.ts`, which is its ONE home (a second spelling of it here was a hazard-32 finding:
 * a later slice adding its module's row to one map would have left the events route denying that module).
 */
documentRoutes.openapi(
  createRoute({
    method: "get",
    path: "/{documentId}/events",
    tags: ["accounting"],
    middleware: [requireDocumentModuleRead({ writeFree: false })] as const,
    summary: "The document's lifecycle timeline, oldest first",
    // No `query`: 2B route decision 3. A timeline is bounded by its own transitions, listDocumentEvents takes
    // no limit or cursor, and advertising ListQuery while ignoring it would let a caller believe ?limit=1 worked.
    request: { params: z.object({ companyId: UuidSchema, documentId: UuidSchema }) },
    responses: {
      200: {
        description: "The document's timeline",
        content: { "application/json": { schema: DocumentEventList } },
      },
      403: {
        description: "Forbidden",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
    },
  }),
  async (c) => {
    const { documentId } = c.req.valid("param");
    const events = await c.var.withTenant((tx) => listDocumentEvents(tx, documentId));
    // The list is returned WHOLE and `next_cursor` is a constant null, which is honest because the route
    // declares no `limit` and no `cursor` to honour (route decision 3). `ListEnvelope` is still used, because
    // §4.2.8 admits no bare-array list response.
    return c.json({ items: events, next_cursor: null }, 200);
  },
);

/**
 * contracts §4.5.9: a synchronous single-document render, `200 application/pdf`. Batch and catalogue
 * rendering is 7A's `reporting.render` job. The gate is §4.5.4's rule for a document read — the type's
 * module read code — resolved per request by `requireDocumentModuleRead` (2C's shared map), and declared
 * write-free: the same fact that lets `REPLAY_BY_RERUN` re-run a replayed key lets a read code gate this
 * POST. The module's static `permissions` list is unchanged — a read code on it would be refused at boot.
 */
documentRoutes.openapi(
  createRoute({
    method: "post",
    path: "/{documentId}/print",
    tags: ["accounting"],
    middleware: [requireDocumentModuleRead({ writeFree: true })] as const,
    summary: "Render a document as a PDF through its print template",
    description:
      "Synchronous single-document render (contracts §4.5.9). Batch and catalogue rendering is the " +
      "reporting.render job (Phase 7). The gate is the read code of the module of the document's type.",
    request: {
      params: z.object({ companyId: UuidSchema, documentId: UuidSchema }),
      headers: IdempotencyHeader,
      body: { content: { "application/json": { schema: PrintDocumentBody } }, required: true },
    },
    responses: {
      200: {
        description: "The rendered document",
        content: { "application/pdf": { schema: z.string().openapi({ format: "binary" }) } },
      },
      400: {
        description: "Invalid",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
      403: {
        description: "Forbidden",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
      404: {
        description: "Not found",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
      422: {
        description: "Unsupported engine",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
    },
  }),
  async (c) => {
    const { documentId } = c.req.valid("param");
    const input = c.req.valid("json");

    // Everything that touches the database happens inside one withTenant; the engine runs outside it,
    // because a browser render must never hold a transaction open (§4.2.2's one-retry contract). That holds
    // end to end only because the idempotency middleware runs a REPLAY_BY_RERUN route outside its own
    // request-spanning transaction — see `idempotency.ts`.
    const source = await c.var
      .withTenant((tx) =>
        renderDocumentSource(tx, {
          documentId,
          lang: input.lang,
          ...(input.templateCode === undefined ? {} : { templateCode: input.templateCode }),
        }),
      )
      .catch((e: unknown) => {
        if (e instanceof PrintError) throw new AppError(e.code, e.detail);
        throw e;
      });

    const pdf = await engineFor(source.engine).render(source.rendered, {
      paper: source.paper,
      dir: source.model.dir,
    });

    // The same document printed twice may differ (Chromium embeds a timestamp — ADR 0032), so no cache
    // validator is offered. Determinism is asserted on the template text, not the bytes.
    return c.body(pdf as unknown as ArrayBuffer, 200, {
      "content-type": "application/pdf",
      "content-disposition": `inline; filename="${source.fileStem}.pdf"`,
      "content-length": String(pdf.byteLength),
      "cache-control": "no-store",
      "x-request-id": c.var.requestId,
    });
  },
);

/**
 * 3C T4 — the fulfilment seam, as three SUB-PATHS on this module and not a module of its own. §4.2.7 says
 * "every `documents` route is generic over document types … a type-specific route is a convention
 * violation", and `PROBES` is keyed by `RouteModule.path`, so these three inherit this module's probe entry
 * exactly as 2B's four sub-paths and 2C's print route do. No `RouteModule` and no `PROBES` key is added.
 * The handlers are generic in shape: they refuse a document whose STATUS is wrong (the 0037 trigger's three
 * rules), never a document whose CODE is not on a list.
 */
documentRoutes.openapi(createDocumentLinksRoute, createDocumentLinks);
documentRoutes.openapi(listDocumentLinksRoute, listDocumentLinks);
documentRoutes.openapi(openQuantityRoute, getOpenQuantity);

/**
 * 3C T9 — the two landed-cost sub-paths, on this same module and for the same reason as the three above.
 * The POST is gated `requireDocumentPermission("submit")` — the stage that resolves the create authority of
 * the document named by `:documentId` — and refuses by POLICY SHAPE (`inventory.effect` must be `receipt`),
 * never by document-type code.
 */
documentRoutes.openapi(allocateLandedCostRoute, allocateLandedCostHandler);
documentRoutes.openapi(listLandedCostRoute, listLandedCostHandler);

/**
 * 3D T7 — the dispatch leg of the two-step transfer, as ONE more sub-path on this module. It carries no
 * `:documentId` (there is no document yet), so §4.5.4's `create` stage resolves the gate from the type the
 * BODY names — `TRANSFER`'s `approval.create`, `inventory.transfer.create`. The route DRAFTS only: the
 * caller issues and posts through 2B's `POST …/documents/{id}/transitions`, whose R2 asks the policy's
 * `approval.post` (`inventory.transfer.post`), which is why those are two codes and this route names one.
 * No `RouteModule` and no `PROBES` key — `/v1/companies/:companyId/documents` is already registered and
 * probed (§4.2.7, hazard 31), so test 12's tenant-isolation coverage picks this sub-path up for free.
 */
documentRoutes.openapi(transferRoute, transferHandler);

/**
 * 3D T8 — the two variance types' sub-paths, mounted here for the same reason the dispatch above is: they
 * are sub-paths of an already-registered, already-probed module, so there is no new `RouteModule` and no
 * `PROBES` key (§4.2.7, hazard 31).
 *
 * `POST …/count-sheet` snapshots a sheet (no `:documentId` yet, so §4.5.4's `create` stage resolves the gate
 * from the BODY's type — `STOCK_COUNT`'s `approval.create`, `inventory.count.create`). `PATCH
 * …/{documentId}/counts` enters figures on a draft sheet. `GET …/{documentId}/count-sheet` reads it under
 * 2C's module read code, nulling `expectedQuantity` for a principal without the approve code — the runbook's
 * one control. `POST …/{documentId}/receipt` drafts the receive leg against the posted `TRANSFER` the path
 * names.
 */
documentRoutes.openapi(countSheetRoute, countSheetHandler);
documentRoutes.openapi(recordCountsRoute, recordCountsHandler);
documentRoutes.openapi(readCountSheetRoute, readCountSheetHandler);
documentRoutes.openapi(transferReceiptRoute, transferReceiptHandler);

/** Any error whose message starts with a token is turned into that AppError; anything else goes through
 *  `fromDatabaseError`. `packages/db` cannot import AppError (§3.1), so the translation happens here — the
 *  same function `documents/link-handlers.ts` and `inventory/landed-cost-handlers.ts` carry, repeated for
 *  the reason the second one states. An AppError raised by this file's own checks passes through
 *  untouched: handing it to `fromDatabaseError` would turn a deliberate 404 into a 500. */
function asAppError(e: unknown): AppError {
  if (e instanceof AppError) return e;
  if (e instanceof Error && /^ERR_[A-Z_]+: /.test(e.message)) {
    const [code, ...rest] = e.message.split(": ");
    return new AppError(code as never, rest.join(": "));
  }
  return fromDatabaseError(e);
}

/**
 * 3D T5 — the order-to-fulfilment conversion, a sub-path of this module for the reason the block above
 * gives. The SOURCE order is the path parameter and the TARGET type is in the body, because the target does
 * not exist yet.
 *
 * **Two gates, and the second one is the point.** `requireDocumentPermission("submit")` resolves the policy
 * of the document `:documentId` names — the ORDER — because this middleware chooses on the PATH and never
 * on the stage (the Phase 2 review fixed it to do so; before that a sub-path gated "create" resolved a type
 * named `""` and 404'd on every call). That gate therefore asks the order's own `approval.create ??
 * approval.post`, which is not the authority this request needs. The authority this request needs is "may
 * this principal raise a DELIVERY_ORDER", and it is asked HERE, against the type named in the BODY, exactly
 * as §4.5.4 describes for the `create` stage. A salesperson who may raise orders must not thereby be able
 * to ship stock.
 */
documentRoutes.openapi(
  createRoute({
    method: "post",
    path: "/{documentId}/convert",
    tags: ["accounting"],
    summary: "Convert an issued order into a fulfilment document (SALES_ORDER → DELIVERY_ORDER)",
    middleware: [requireDocumentPermission("submit")] as const,
    request: {
      headers: IdempotencyHeader,
      params: z.object({ companyId: UuidSchema, documentId: UuidSchema }),
      body: { content: { "application/json": { schema: ConvertDocumentBody } } },
    },
    responses: {
      201: {
        description: "The drafted fulfilment document",
        content: { "application/json": { schema: ConvertResultSchema } },
      },
      400: {
        description:
          "Invalid body; the source is not issued; or the target is a type only its own service drafts (FX_REVALUATION)",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
      403: {
        description: "Forbidden",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
      404: {
        description: "Source document, line, target type or warehouse not found",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
      422: {
        description: "Over-fulfilment",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
    },
  }),
  async (c) => {
    const { companyId, documentId } = c.req.valid("param");
    const body = c.req.valid("json");
    // Code review 3, R6: the TARGET type comes from the body, as it does on every route that takes a type
    // code there (see `refuseServiceOnlyType`), so a service-only type is refused the same way — before any
    // read, as the create route does.
    refuseServiceOnlyType(body.targetDocumentTypeCode);
    try {
      const result = await c.var.withTenant(async (tx) => {
        // Bound to the PATH company, not to the tenant: `document_type` is unique on
        // (company_id, code), so an unbound lookup would hand a caller authorised for company A the
        // sibling company B's type of the same code — and then draft A's delivery under B's policy.
        const [type] = await tx<{ id: string }[]>`
          select id from app.document_type
           where code = ${body.targetDocumentTypeCode} and company_id = ${companyId}
             and archived_at is null`;
        if (type === undefined) {
          throw new AppError(
            "ERR_NOT_FOUND",
            `no document type ${body.targetDocumentTypeCode} in company ${companyId}`,
          );
        }
        // The warehouse every drafted line will carry. `document_line`'s foreign keys are composite on
        // (tenant_id, …) and bound the TENANT only, so without this a caller authorised for company A
        // ships from company B's warehouse (§4.5's "bind both sides of any link").
        const [warehouse] = await tx<{ id: string }[]>`
          select id from app.warehouse
           where id = ${body.warehouseId} and company_id = ${companyId} and archived_at is null`;
        if (warehouse === undefined) {
          throw new AppError(
            "ERR_NOT_FOUND",
            `no warehouse ${body.warehouseId} in company ${companyId}`,
          );
        }

        // The SOURCE order, bound to the path company. The gate above already answered 404 for a document
        // of another company, but the branch is read here because the drafted delivery inherits it and
        // `actor_has` with a NULL branch demands company-wide authority — a principal assigned to one
        // branch would be refused for the wrong reason (spec:2166, LEGACY-042).
        const [order] = await tx<{ branch_id: string }[]>`
          select branch_id from app.document
           where id = ${documentId} and company_id = ${companyId}`;
        if (order === undefined) {
          throw new AppError("ERR_NOT_FOUND", `no document ${documentId} in company ${companyId}`);
        }

        const { definition } = await resolvePolicy(tx, type.id, body.effectiveDate);
        const code = stageCode("create", definition.approval);
        const [row] = await tx<{ ok: boolean }[]>`
          select app.actor_has(${code}, ${companyId}::uuid, ${order.branch_id}::uuid) as ok`;
        if (row?.ok !== true) {
          throw new AppError(
            "ERR_RBAC_FORBIDDEN",
            `${code} is required to create a ${definition.documentType} in company ${companyId}`,
          );
        }

        return convertOrderToDelivery(tx, c.var.ctx, {
          sourceDocumentId: documentId,
          targetDocumentTypeId: type.id,
          targetSeries: body.targetSeries,
          effectiveDate: body.effectiveDate,
          warehouseId: body.warehouseId,
          fefo: body.fefo,
          lines: body.lines,
        });
      });
      return c.json(result, 201);
    } catch (e) {
      throw asAppError(e);
    }
  },
);

/**
 * 4A T6 — the stock-to-invoice conversion (spec:1051's "4 (invoice link)"), one more sub-path of this module:
 * no `RouteModule` and no `PROBES` key (§4.2.7, hazard 31). The SOURCE delivery (or receipt) is the path
 * parameter and the TARGET type is in the body, because the target does not exist yet. The route DRAFTS:
 * issuing and posting is 2B's `POST …/{documentId}/transitions`, whose R2 asks the invoice policy's
 * `approval.post`.
 *
 * **Two gates, exactly as 3D's `…/convert` above, and for the same reason.** `requireDocumentPermission
 * ("submit")` — 3C's rule for a POST sub-path of an existing document — resolves the SOURCE's policy, which
 * for a DELIVERY_ORDER is `inventory.transfer.create`: a warehouse authority. The authority this request
 * needs is "may this principal raise a SALES_INVOICE", and it is asked HERE, against the type the BODY names,
 * as §4.5.4 describes for the `create` stage. A picker who may ship stock must not thereby be able to raise
 * an invoice (4A's plan named this narrowing as the open question of its self-review; the tree's own
 * precedent answers it).
 *
 * The path company is passed down into the service, which matches the source document AND the target type on
 * it (AGENTS.md: an entity id alone reaches a sibling company's rows inside the same tenant).
 */
documentRoutes.openapi(
  createRoute({
    method: "post",
    path: "/{documentId}/convert-to-invoice",
    tags: ["accounting"],
    summary:
      "Convert a posted delivery or receipt into a draft invoice (DELIVERY_ORDER → SALES_INVOICE)",
    middleware: [requireDocumentPermission("submit")] as const,
    request: {
      headers: IdempotencyHeader,
      params: z.object({ companyId: UuidSchema, documentId: UuidSchema }),
      body: { content: { "application/json": { schema: ConvertToInvoiceBody } } },
    },
    responses: {
      201: {
        description: "The draft invoice, its lines and its converts_to links",
        content: { "application/json": { schema: ConvertToInvoiceResultSchema } },
      },
      400: {
        description:
          "Invalid body; a line not on the source or asked twice; a source that is not a stock movement in the target's direction, or has nothing open; a tax code, named or inherited from the source's lines, on a tax-inclusive source under a target that applies tax; a coded line into a target type whose policy declares tax inclusive. `taxCodeId: null` (body or line) converts without a code and clears an inherited one",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
      403: {
        description: "Forbidden — on the source's create code, or on the target type's",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
      404: {
        description: "Source document, target type or tax code not found in this company",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
      409: {
        description: "The source is not posted",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
      422: {
        description:
          "Over-fulfilment; no policy for the target type on the effective date; or a tax code archived or not effective on that date (ERR_TAX_REGIME_MISMATCH)",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
    },
  }),
  async (c) => {
    const { companyId, documentId } = c.req.valid("param");
    const body = c.req.valid("json");
    try {
      const result = await c.var.withTenant(async (tx) => {
        const targetTypeId = await requireTargetCreate(tx, {
          companyId,
          sourceDocumentId: documentId,
          targetDocumentTypeId: body.targetDocumentTypeId,
          effectiveDate: body.effectiveDate,
        });
        return convertToInvoice(tx, c.var.ctx, {
          companyId,
          sourceDocumentId: documentId,
          targetDocumentTypeId: targetTypeId,
          targetSeries: body.targetSeries,
          effectiveDate: body.effectiveDate,
          // 5A: the service binds every tax code to the path company and computes the tax at persist time.
          // Passed through as parsed: absent is "inherit", an explicit `null` is "no code".
          taxCodeId: body.taxCodeId,
          lines: body.lines,
        });
      });
      return c.json(result, 201);
    } catch (e) {
      throw asAppError(e);
    }
  },
);

/**
 * 4A — the TARGET type's gate, the second of the two gates `…/convert-to-invoice` and `…/credit-note` carry
 * (3D's `…/convert` asks the same question in its own handler). Returns the target type's id.
 *
 * The type is bound to the PATH company: RLS bounds the tenant and nothing else, so an unbound lookup by id
 * would hand a caller authorised for company A the sibling company B's type — and B's policy. The code asked
 * is the target policy's `create` stage (§4.5.4), at the SOURCE's branch, because the new document inherits
 * it and `actor_has` with a NULL branch demands company-wide authority (spec:2166, LEGACY-042). The first gate
 * already 404'd a source of another company; the source read here is bound all the same.
 */
async function requireTargetCreate(
  tx: Tx,
  input: {
    companyId: string;
    sourceDocumentId: string;
    targetDocumentTypeId: string;
    effectiveDate: string;
  },
): Promise<string> {
  const { companyId } = input;
  const [type] = await tx<{ id: string }[]>`
    select id from app.document_type
     where id = ${input.targetDocumentTypeId} and company_id = ${companyId}
       and archived_at is null`;
  if (type === undefined) {
    throw new AppError(
      "ERR_NOT_FOUND",
      `no document type ${input.targetDocumentTypeId} in company ${companyId}`,
    );
  }
  const [source] = await tx<{ branch_id: string }[]>`
    select branch_id from app.document
     where id = ${input.sourceDocumentId} and company_id = ${companyId}`;
  if (source === undefined) {
    throw new AppError(
      "ERR_NOT_FOUND",
      `no document ${input.sourceDocumentId} in company ${companyId}`,
    );
  }
  const { definition } = await resolvePolicy(tx, type.id, input.effectiveDate);
  const code = stageCode("create", definition.approval);
  const [row] = await tx<{ ok: boolean }[]>`
    select app.actor_has(${code}, ${companyId}::uuid, ${source.branch_id}::uuid) as ok`;
  if (row?.ok !== true) {
    throw new AppError(
      "ERR_RBAC_FORBIDDEN",
      `${code} is required to create a ${definition.documentType} in company ${companyId}`,
    );
  }
  return type.id;
}

/**
 * 4A T8 — the PARTIAL credit note against a posted invoice (spec:2024), one more sub-path of this module: no
 * `RouteModule` and no `PROBES` key (§4.2.7, hazard 31). The INVOICE being credited is the path parameter; a
 * FULL credit is 2B's `…/reverse`, which produces the same type through `reverseDocument`.
 *
 * **Two gates, as `…/convert-to-invoice` beside it.** `requireDocumentPermission("submit")` — 3C's rule for a
 * POST sub-path of an existing document — resolves the INVOICE's policy, so a principal who may not raise the
 * sale may not raise its credit note; `requireTargetCreate` then asks the credit-note type's own `create`
 * code, so a tenant that separates the two authorities is obeyed. Posting the note still needs the
 * credit-note policy's `approval.post`, asked by the status trigger (R2) at `POST …/transitions`.
 *
 * **The route returns an ISSUED note, not a draft, and that is what makes `reason` land.** `creditNoteFrom`
 * puts the reason on `app.event_reason`, which is transaction-scoped, and 2B's only writer of
 * `document_event` is an AFTER UPDATE OF status trigger — the INSERT of a draft records nothing. So the note is
 * issued on the SAME transaction: returning a draft would make `reason` a field the API requires, accepts and
 * drops. `draft → issued` needs no further gate: §4.5.1 admits it when `approval.required` is false, which
 * both credit-note policies set, and R2 evaluates no code for `issued` (ADR 0029). A conversion, by contrast,
 * returns a draft because its prices, lines and date are still the user's to edit; a credit note is the
 * negation of an already-posted invoice and nothing is left to decide.
 *
 * The path company is passed down into the service, which matches the invoice AND the target type on it
 * (AGENTS.md).
 */
documentRoutes.openapi(
  createRoute({
    method: "post",
    path: "/{documentId}/credit-note",
    tags: ["accounting"],
    summary:
      "Credit part of a posted invoice (SALES_INVOICE → SALES_CREDIT_NOTE), issued with its reason",
    middleware: [requireDocumentPermission("submit")] as const,
    request: {
      headers: IdempotencyHeader,
      params: z.object({ companyId: UuidSchema, documentId: UuidSchema }),
      body: { content: { "application/json": { schema: CreditNoteBody } } },
    },
    responses: {
      201: {
        description:
          "The ISSUED credit note, its lines and its returns links; reverses_document_id is the invoice",
        content: { "application/json": { schema: CreditNoteResultSchema } },
      },
      400: {
        description:
          "Invalid body or reason; a line not on the invoice, asked twice or carrying no quantity; a line holding a returns claim that no credit note of the invoice wrote as a share of that line alone with total = amount + tax (the claim's document is named); a stock document; a target that is not the invoice's reversal type; nothing left to credit",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
      403: {
        description:
          "Forbidden — on the invoice's create code, on the credit-note type's create code, or on its issue code at the invoice's branch",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
      404: {
        description: "Invoice or target type not found in this company",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
      409: {
        description: "The invoice is not posted",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
      422: {
        description:
          "Over-credited, or no policy for the target type on the effective date, or no open period for it",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
    },
  }),
  async (c) => {
    const { companyId, documentId } = c.req.valid("param");
    const body = c.req.valid("json");
    try {
      const result = await c.var.withTenant(async (tx) => {
        const targetTypeId = await requireTargetCreate(tx, {
          companyId,
          sourceDocumentId: documentId,
          targetDocumentTypeId: body.targetDocumentTypeId,
          effectiveDate: body.effectiveDate,
        });
        // S3: the route ISSUES the note, and 2B's trigger evaluates no code at `→ issued` (ADR 0029) — so the
        // issue stage's code is asked here, of the credit note's own policy, at the invoice's branch (which
        // the note inherits), before anything is drafted. Otherwise a clerk holding the two create codes
        // issued a numbered credit note that only a principal holding the post code may issue.
        const { definition: cnPolicy } = await resolvePolicy(tx, targetTypeId, body.effectiveDate);
        const issueCode = stageCode("issue", cnPolicy.approval);
        const [allowed] = await tx<{ ok: boolean }[]>`
          select app.actor_has(${issueCode}, ${companyId}::uuid, d.branch_id) as ok
            from app.document d where d.id = ${documentId} and d.company_id = ${companyId}`;
        if (allowed?.ok !== true) {
          throw new AppError(
            "ERR_RBAC_FORBIDDEN",
            `${issueCode} is required to issue a ${cnPolicy.documentType} in company ${companyId}`,
          );
        }
        const note = await creditNoteFrom(tx, c.var.ctx, {
          companyId,
          settledDocumentId: documentId,
          targetDocumentTypeId: targetTypeId,
          targetSeries: body.targetSeries,
          effectiveDate: body.effectiveDate,
          reason: body.reason,
          lines: body.lines,
        });
        await issueDocument(tx, c.var.ctx, { documentId: note.documentId });
        return note;
      });
      return c.json(result, 201);
    } catch (e) {
      throw asAppError(e);
    }
  },
);

/**
 * Phase 4 review S1 (spec:2166, LEGACY-042) — an allocation acts on EVERY document it names, not only on the
 * settlement the gate cleared: `requireDocumentPermission` asks the code at the SETTLEMENT's branch, so a
 * clerk restricted to one branch could mark another branch's invoices paid. This asks the same code at each
 * settled document's own branch — `actor_has` with that branch, never a NULL one (a NULL branch demands
 * company-wide authority). Bound to the path company: a document of another company is not read here, and
 * the service's own read 404s it.
 */
async function requireCodeAtBranches(
  tx: Tx,
  input: { companyId: string; code: string; stage: DocumentStage; documentIds: readonly string[] },
): Promise<void> {
  const ids = [...new Set(input.documentIds)];
  if (ids.length === 0) return;
  const rows = await tx<{ id: string; ok: boolean }[]>`
    select d.id, app.actor_has(${input.code}, ${input.companyId}::uuid, d.branch_id) as ok
      from app.document d
     where d.id = any(${ids}::uuid[]) and d.company_id = ${input.companyId}
     order by d.id`;
  const denied = rows.find((r) => r.ok !== true);
  if (denied !== undefined) {
    throw new AppError(
      "ERR_RBAC_FORBIDDEN",
      `${input.code} is required at the branch of document ${denied.id} to ${input.stage} an allocation against it in company ${input.companyId}`,
    );
  }
}

/** The code `requireDocumentPermission(stage)` asked for the path document — resolved the same way, from the
 *  document's type at its effective date — so S1's per-document check asks exactly the gate's question. */
async function pathDocumentCode(
  tx: Tx,
  companyId: string,
  documentId: string,
  stage: DocumentStage,
): Promise<string> {
  const [doc] = await tx<{ document_type_id: string; effective_date: string }[]>`
    select document_type_id, to_char(effective_date, 'YYYY-MM-DD') as effective_date
      from app.document where id = ${documentId} and company_id = ${companyId}`;
  if (doc === undefined) {
    throw new AppError("ERR_NOT_FOUND", `no document ${documentId} in company ${companyId}`);
  }
  const { definition } = await resolvePolicy(tx, doc.document_type_id, doc.effective_date);
  return stageCode(stage, definition.approval);
}

/**
 * 4A T9 — allocation (contracts §4.8.1, spec:1042), four more sub-paths of this module: no `RouteModule` and no
 * `PROBES` key (§4.2.7, hazard 31). **Allocation is not a ledger fact**: the settlement's own posting relieved
 * the control account, and these routes record — and reverse — which documents it paid, without touching a
 * posted entry (spec:2457).
 *
 * The document on the path of the two WRITES is the SETTLEMENT (a receipt, a payment or a credit note), so
 * `requireDocumentPermission("submit")` — 3C's rule for a POST sub-path of an existing document — asks the
 * settlement type's own `approval.create ?? approval.post`: `accounting.receipt.create` for a RECEIPT,
 * `accounting.payment.create` for a PAYMENT. The two READS are gated by the type's module read code (§4.5.4's
 * last paragraph); `requireDocumentPermission` maps write stages only. Every handler passes the path company
 * into the service, which binds the settlement AND every settled document to it (AGENTS.md: RLS bounds the
 * tenant only); `unallocate` is also bound to the path settlement, so an allocation id alone reaches nothing.
 */
const AllocationParams = z.object({
  companyId: UuidSchema,
  documentId: UuidSchema,
  allocationId: UuidSchema,
});

/** `AllocationRow` carries 4-dp strings; the wire carries `{ amount, currency }`. The three currencies are
 *  read from the row's own documents in `listAllocations`' projection — `amount` in the settled document's
 *  currency, `settlementAmount` in the settlement's (4B), `baseAmount` and `fxDifference` in base — and
 *  DESTRUCTURED OUT here: they are carriers, not members of `AllocationSchema`. Declared once because three
 *  handlers return the same shape (hazard 9). */
const toAllocationDto = ({
  currency: settledCurrency,
  settlementCurrency,
  baseCurrency,
  ...row
}: AllocationRow) => ({
  ...row,
  amount: { amount: row.amount, currency: settledCurrency },
  settlementAmount: { amount: row.settlementAmount, currency: settlementCurrency },
  baseAmount: { amount: row.baseAmount, currency: baseCurrency },
  fxDifference: { amount: row.fxDifference, currency: baseCurrency },
});

documentRoutes.openapi(
  createRoute({
    method: "post",
    path: "/{documentId}/allocations",
    tags: ["accounting"],
    summary:
      "Allocate a posted settlement (receipt, payment or credit note) against posted documents of its party",
    middleware: [requireDocumentPermission("submit")] as const,
    request: {
      headers: IdempotencyHeader,
      params: z.object({ companyId: UuidSchema, documentId: UuidSchema }),
      body: { content: { "application/json": { schema: AllocateSettlementBody } } },
    },
    responses: {
      201: {
        description:
          "Allocated; a non-zero fxDifference (base) is posted in the same transaction as realised FX_REVALUATION documents (fxDocumentIds)",
        content: { "application/json": { schema: AllocateSettlementResultSchema } },
      },
      400: {
        description:
          "Invalid body; over-allocated against the settlement or a settled document's open balance; another party; a pair on the same side of the control account; a cross-currency line without settlementAmount",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
      403: {
        description:
          "Forbidden — on the settlement type's create code at the settlement's branch or at any settled document's branch, or (from the status trigger) accounting.journal.post when the allocation realises an FX difference",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
      404: {
        description: "The settlement or a settled document is not in this company",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
      409: {
        description: "The settlement or a settled document is not posted",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
      422: {
        description:
          "A line's amount is not in its settled document's currency, or its settlementAmount not in the settlement's; or a realised FX difference cannot post (no open period, no 4900/5910, no FX_REVALUATION type)",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
    },
  }),
  async (c) => {
    const { companyId, documentId } = c.req.valid("param");
    const { lines } = c.req.valid("json");
    try {
      // 4B (ADR 0047): the realised FX difference posts in the SAME transaction as the allocation. A later,
      // separate call would leave the §4.8.2 tie-out false in between, which a reader of the ageing report
      // could observe.
      const result = await c.var.withTenant(async (tx) => {
        // S1: the gate's code at every settled document's own branch, before anything is written.
        await requireCodeAtBranches(tx, {
          companyId,
          code: await pathDocumentCode(tx, companyId, documentId, "submit"),
          stage: "submit",
          documentIds: lines.map((l) => l.settledDocumentId),
        });
        return settleWithFx(tx, c.var.ctx, {
          companyId,
          settlementDocumentId: documentId,
          lines: lines.map((l) => ({
            settledDocumentId: l.settledDocumentId,
            amount: Money.fromJSON(l.amount),
            ...(l.settlementAmount === undefined
              ? {}
              : { settlementAmount: Money.fromJSON(l.settlementAmount) }),
          })),
          jobs: c.var.jobs,
        });
      });
      return c.json(
        {
          allocationIds: result.allocationIds,
          fxDifference: result.fxDifference.toJSON(),
          fxDocumentIds: result.fxDocumentIds,
        },
        201,
      );
    } catch (e) {
      throw asAppError(e);
    }
  },
);

documentRoutes.openapi(
  createRoute({
    method: "get",
    path: "/{documentId}/allocations",
    tags: ["accounting"],
    summary:
      "The allocations of this document as a settlement AND against it as a settled document",
    middleware: [requireDocumentModuleRead({ writeFree: false })] as const,
    request: {
      params: z.object({ companyId: UuidSchema, documentId: UuidSchema }),
      query: AllocationQuery,
    },
    responses: {
      200: {
        description:
          "Live allocations by default; the reversed ones with filter[unallocated][eq]=true",
        content: { "application/json": { schema: AllocationList } },
      },
      403: {
        description: "Forbidden",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
      404: {
        description: "Not in this company",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
    },
  }),
  async (c) => {
    const { companyId, documentId } = c.req.valid("param");
    const reversed = c.req.valid("query")["filter[unallocated][eq]"] === "true";
    // BOTH directions in one read: a document is a settlement in some rows and a settled document in others,
    // and a clerk looking at an invoice wants the receipts that paid it. The distinct CHECK means no row is
    // both, so the union has no duplicate. The whole list, like `…/events`: no `limit` is declared to honour.
    const rows = await c.var.withTenant(async (tx) => [
      ...(await listAllocations(tx, {
        companyId,
        settlementDocumentId: documentId,
        includeUnallocated: reversed,
      })),
      ...(await listAllocations(tx, {
        companyId,
        settledDocumentId: documentId,
        includeUnallocated: reversed,
      })),
    ]);
    const items = rows.filter((r) => (r.unallocatedAt !== null) === reversed).map(toAllocationDto);
    return c.json({ items, next_cursor: null }, 200);
  },
);

documentRoutes.openapi(
  createRoute({
    method: "post",
    path: "/{documentId}/allocations/{allocationId}/unallocate",
    tags: ["accounting"],
    summary: "Reverse one live allocation of this settlement, with its compelled reason",
    middleware: [requireDocumentPermission("submit")] as const,
    request: {
      headers: IdempotencyHeader,
      params: AllocationParams,
      body: { content: { "application/json": { schema: UnallocateBody } } },
    },
    responses: {
      200: {
        description: "Reversed; the reason and the reverser are stored on the row",
        content: { "application/json": { schema: AllocationSchema } },
      },
      400: {
        description: "Invalid body or an empty reason",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
      403: {
        description:
          "Forbidden — on the settlement type's create code at the settlement's branch or at the settled document's branch, or (from the status trigger) accounting.journal.post when the un-allocation withdraws a realised FX difference",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
      404: {
        description: "No open allocation with that id on this settlement in this company",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
      422: {
        description:
          "The realised FX difference the allocation posted cannot be withdrawn (its period is not open)",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
    },
  }),
  async (c) => {
    const { companyId, documentId, allocationId } = c.req.valid("param");
    const { reason } = c.req.valid("json");
    try {
      const row = await c.var.withTenant(async (tx) => {
        // S1: the settled document of THIS allocation — bound to the path settlement and company, so an id of
        // another settlement's row names nothing here and `unallocate` 404s it below.
        const [target] = await tx<{ settled: string }[]>`
          select settled_document_id as settled from app.allocation
           where id = ${allocationId} and settlement_document_id = ${documentId}
             and company_id = ${companyId}`;
        if (target !== undefined) {
          await requireCodeAtBranches(tx, {
            companyId,
            code: await pathDocumentCode(tx, companyId, documentId, "submit"),
            stage: "submit",
            documentIds: [target.settled],
          });
        }
        await unallocate(tx, c.var.ctx, {
          companyId,
          settlementDocumentId: documentId,
          allocationId,
          reason,
        });
        // 4B (ADR 0047): an un-allocation withdraws the realised FX difference its allocation posted, in the
        // same transaction, for the reason the allocation route posts it in its own.
        await postSettlementFxDifference(tx, c.var.ctx, {
          companyId,
          settlementDocumentId: documentId,
          jobs: c.var.jobs,
        });
        // `.find`, not `[0]`: `listAllocations` returns EVERY allocation of this settlement and the reversed
        // one is not necessarily the first.
        const all = await listAllocations(tx, {
          companyId,
          settlementDocumentId: documentId,
          includeUnallocated: true,
        });
        return all.find((r) => r.id === allocationId);
      });
      if (row === undefined) throw new AppError("ERR_NOT_FOUND", "the allocation is not visible");
      return c.json(toAllocationDto(row), 200);
    } catch (e) {
      throw asAppError(e);
    }
  },
);

documentRoutes.openapi(
  createRoute({
    method: "get",
    path: "/{documentId}/open-balance",
    tags: ["accounting"],
    summary: "The document's total less its live allocations, in its own currency and in base",
    middleware: [requireDocumentModuleRead({ writeFree: false })] as const,
    request: { params: z.object({ companyId: UuidSchema, documentId: UuidSchema }) },
    responses: {
      200: {
        description: "|total| − Σ live allocations (contracts §4.8.1)",
        content: { "application/json": { schema: OpenBalanceSchema } },
      },
      403: {
        description: "Forbidden",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
      404: {
        description: "Not in this company",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
    },
  }),
  async (c) => {
    const { companyId, documentId } = c.req.valid("param");
    try {
      const open = await c.var.withTenant((tx) => openBalance(tx, { companyId, documentId }));
      return c.json(
        { documentId, document: open.document.toJSON(), base: open.base.toJSON() },
        200,
      );
    } catch (e) {
      throw asAppError(e);
    }
  },
);

/**
 * 4A T10 — RECEIPT and PAYMENT (§4.14, spec:2147), one more sub-path of this module: no `RouteModule` and no
 * `PROBES` key (§4.2.7, hazard 31). spec:2147's asymmetry — "receipts (money in) need no maker-checker,
 * payments (money out) do" — is the two policies' `approval` blocks, not code here.
 *
 * **Gated `"create"`, not `"submit"`**: 3C's rule ("a POST sub-path of an EXISTING document uses submit") is
 * about a path carrying a `{documentId}`, and this one creates the document. §4.5.4's create branch resolves
 * the policy of the type the BODY names (`documentTypeCode`, at `effectiveDate` and `branchId`), so a RECEIPT
 * body asks `accounting.receipt.create` and a PAYMENT body `accounting.payment.create` — the shape of 3D's
 * `…/documents/transfers`. The handler resolves the type on the PATH company and passes that company into the
 * service, which binds the type, party, bank account and branch to it (AGENTS.md: RLS bounds the tenant only).
 *
 * **One `c.var.withTenant` for the whole call.** With `allocations`, `draftSettlement` issues, posts and
 * allocates a RECEIPT on the transaction it is given, so a refusal anywhere rolls all of it back; two
 * transactions would post a settlement and then fail to allocate it. Posting is authorised where it always
 * is, by 2B's status trigger (R2, `accounting.receipt.post`), not by a second gate here. A PAYMENT is always
 * returned as a DRAFT — R1 needs two principals in two sessions, walked through `…/{documentId}/transitions`,
 * and its allocations go through `…/{documentId}/allocations` once it is posted.
 */
documentRoutes.openapi(
  createRoute({
    method: "post",
    path: "/settlements",
    tags: ["accounting"],
    summary:
      "Draft a receipt or payment; a receipt with allocations is posted and allocated in the same transaction",
    middleware: [requireDocumentPermission("create")] as const,
    request: {
      headers: IdempotencyHeader,
      params: z.object({ companyId: UuidSchema }),
      body: { content: { "application/json": { schema: DraftSettlementBody } } },
    },
    responses: {
      201: {
        description:
          "The settlement — a draft when allocations is empty, posted and allocated otherwise",
        content: { "application/json": { schema: SettlementResultSchema } },
      },
      400: {
        description:
          "Invalid body; not a settlement type or not its series; a base-currency rate that is not 1; allocations on a type that needs approval; over-allocated",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
      403: {
        description:
          "Forbidden — on the type's create code (at the body's branch and at every settled document's branch), or (from the status trigger) its post code, or accounting.journal.post when an allocation realises an FX difference",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
      404: {
        description: "Type, party, bank account, branch or a settled document not in this company",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
      409: {
        description: "A settled document that is not posted",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
      422: {
        description:
          "No policy or open period on the effective date, or a settled document in another currency",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
    },
  }),
  async (c) => {
    const { companyId } = c.req.valid("param");
    const body = c.req.valid("json");
    // Code review 4: the type code comes from the body, so a service-only type is refused before any read, as
    // on every such route (see `refuseServiceOnlyType`). draftSettlement's shape check would refuse it too,
    // but only after the lookup below.
    refuseServiceOnlyType(body.documentTypeCode);
    try {
      const result = await c.var.withTenant(async (tx) => {
        const [type] = await tx<{ id: string }[]>`
          select id from app.document_type
           where company_id = ${companyId} and code = ${body.documentTypeCode} and archived_at is null`;
        if (type === undefined) {
          throw new AppError(
            "ERR_NOT_FOUND",
            `company ${companyId} has no document type ${body.documentTypeCode}`,
          );
        }
        // S1: the create code the gate asked at the body's branch, asked again at every settled document's.
        if (body.allocations.length > 0) {
          const { definition } = await resolvePolicy(tx, type.id, body.effectiveDate);
          await requireCodeAtBranches(tx, {
            companyId,
            code: stageCode("create", definition.approval),
            stage: "create",
            documentIds: body.allocations.map((a) => a.settledDocumentId),
          });
        }
        const drafted = await draftSettlement(tx, c.var.ctx, {
          companyId,
          documentTypeId: type.id,
          series: body.series,
          effectiveDate: body.effectiveDate,
          partyId: body.partyId,
          bankAccountId: body.bankAccountId,
          branchId: body.branchId,
          currency: body.currency,
          exchangeRate: body.exchangeRate,
          amount: body.amount,
          reference: body.reference ?? null,
          allocations: body.allocations,
          jobs: c.var.jobs,
        });
        // The posting's warnings are not part of the wire result; they are logged, never dropped.
        const { warnings, ...settled } = drafted;
        for (const warning of warnings) {
          c.var.logger.warn({ document_id: settled.documentId }, warning);
        }
        // 4B (ADR 0047): a receipt posted and allocated here posts its realised FX difference in the same
        // transaction too — the same rule as `…/{documentId}/allocations`.
        const fx =
          settled.allocationIds.length === 0
            ? null
            : await postSettlementFxDifference(tx, c.var.ctx, {
                companyId,
                settlementDocumentId: settled.documentId,
                jobs: c.var.jobs,
              });
        return { ...settled, fxDocumentIds: fx?.fxDocumentIds ?? [] };
      });
      return c.json(result, 201);
    } catch (e) {
      throw asAppError(e);
    }
  },
);

/**
 * 4B T5 — the unrealised period-end revaluation (§4.14's FX_REVALUATION, ADR 0047), one more sub-path of this
 * module: no `RouteModule` and no `PROBES` key (§4.2.7, hazard 31), the precedent 3D set with `…/transfers`.
 *
 * Gated by the STATIC code §3.6.2 assigns the type ("the FX-revaluation and cost-adjustment documents post
 * under `accounting.journal.post`"), not by `requireDocumentPermission`: the document does not exist yet and
 * its type is not in the body, so there is no policy to resolve. The path company is passed into the service,
 * which binds the period, the accounts and the branch to it (AGENTS.md: RLS bounds the tenant only).
 */
const revalue = requirePermission(PERMISSION["accounting.journal.post"], {
  company: "path:companyId",
});

documentRoutes.openapi(
  createRoute({
    method: "post",
    path: "/revaluations",
    tags: ["accounting"],
    summary:
      "Post the unrealised FX revaluation of a fiscal period, dated its last day (FX_REVALUATION)",
    middleware: [revalue] as const,
    request: {
      headers: IdempotencyHeader,
      params: z.object({ companyId: UuidSchema }),
      body: { content: { "application/json": { schema: RevalueBody } } },
    },
    responses: {
      201: {
        description:
          "The revaluation — documentId null when nothing was exposed or the period was already revalued",
        content: { "application/json": { schema: RevaluationResultSchema } },
      },
      400: {
        description: "Invalid body",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
      403: {
        description: "Forbidden — accounting.journal.post in this company",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
      422: {
        description:
          "ERR_PERIOD_NOT_FOUND, ERR_PERIOD_NOT_OPEN, ERR_RATE_NOT_FOUND (naming the pair) or ERR_POLICY_REQUIRES_MISSING",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
    },
  }),
  async (c) => {
    const { companyId } = c.req.valid("param");
    const { fiscalPeriodId } = c.req.valid("json");
    try {
      const result = await c.var.withTenant((tx) =>
        revalueAtPeriodEnd(tx, c.var.ctx, { companyId, fiscalPeriodId, jobs: c.var.jobs }),
      );
      const base = result.baseCurrency;
      return c.json(
        {
          documentId: result.documentId,
          fiscalPeriodId: result.fiscalPeriodId,
          asOf: result.asOf,
          baseCurrency: base,
          lines: result.lines.map((l) => ({
            accountId: l.accountId,
            accountCode: l.accountCode,
            currency: l.currency,
            amountCcy: { amount: l.amountCcy, currency: l.currency },
            carriedBase: { amount: l.carriedBase, currency: base },
            revaluedBase: { amount: l.revaluedBase, currency: base },
            delta: { amount: l.delta, currency: base },
            rate: l.rate,
          })),
        },
        201,
      );
    } catch (e) {
      throw asAppError(e);
    }
  },
);

type Tx = Parameters<Parameters<AppEnv["Variables"]["withTenant"]>[0]>[0];

/** The line as accepted, after Zod: `DocumentLineInput`'s output type. `exactOptionalPropertyTypes` is on,
 *  and Zod hands an optional field through as `string | undefined` rather than as an absent key, so each
 *  optional is declared with `| undefined` explicitly. `taxCodeId` is deliberately absent — migration 0019
 *  adds that column with no foreign key and 5A's 0055 adds the key. `itemId` and 3A's four inventory fields
 *  are here because migration 0032 added their keys (contracts §4.3.4). */
type LineWrite = {
  lineNo: number;
  kind: "account" | "item" | "tax" | "text" | "tender" | "payroll";
  description?: string | undefined;
  accountId?: string | undefined;
  debit: string;
  credit: string;
  quantity?: string | undefined;
  unitPrice?: string | undefined;
  discount: string;
  amount: string;
  taxCodeId?: string | undefined;
  itemId?: string | undefined;
  warehouseId?: string | undefined;
  lotId?: string | undefined;
  unitId?: string | undefined;
  unitQuantity?: string | undefined;
  dimensions: Record<string, string>;
  customFields: Record<string, unknown>;
};

/**
 * Every id a line carries must belong to THIS company. The foreign keys are tenant-scoped —
 * document_line (tenant_id, account_id) → account(tenant_id, id), and dimension values likewise — so
 * without this a caller authorised for company A can post to company B's accounts: ledger_entry and
 * account_balance rows land under A's company_id with B's account_id, A's trial balance shows an account
 * of B's, and B's never does. This is the exact class AGENTS.md warns of ("an entity id alone lets a caller
 * authorised for one company reach another's rows"). Group and archived accounts are refused too: the
 * evaluator resolves `line.accountId` verbatim, so nothing downstream would. An item, tax or text line
 * legitimately carries no account (2A) and is skipped by the account half.
 */
async function assertLinesBelong(
  tx: Tx,
  companyId: string,
  lines: readonly LineWrite[],
): Promise<void> {
  const taxIds = [...new Set(lines.flatMap((line) => (line.taxCodeId ? [line.taxCodeId] : [])))];
  if (taxIds.length > 0) {
    const found = await tx<
      { id: string }[]
    >`select id from app.tax_code where company_id = ${companyId} and id = any(${taxIds}::uuid[])`;
    if (found.length !== taxIds.length)
      throw new AppError("ERR_NOT_FOUND", "tax code is not in this company");
  }
  const withAccount = lines.filter(
    (line): line is LineWrite & { accountId: string } => line.accountId !== undefined,
  );
  const accountIds = [...new Set(withAccount.map((line) => line.accountId))];
  if (accountIds.length > 0) {
    const accounts = await tx<{ id: string; is_group: boolean; archived: boolean }[]>`
      select id, is_group, (archived_at is not null) as archived
        from app.account
       where company_id = ${companyId} and id = any(${accountIds}::uuid[])`;
    const byId = new Map(accounts.map((account) => [account.id, account]));
    for (const line of withAccount) {
      const account = byId.get(line.accountId);
      if (!account) {
        throw new AppError(
          "ERR_NOT_FOUND",
          `line ${line.lineNo}: no account ${line.accountId} in company ${companyId}`,
        );
      }
      if (account.is_group) {
        throw new AppError(
          "ERR_VALIDATION_FAILED",
          `line ${line.lineNo}: account ${line.accountId} is a group and takes no postings`,
        );
      }
      if (account.archived) {
        throw new AppError(
          "ERR_VALIDATION_FAILED",
          `line ${line.lineNo}: account ${line.accountId} is archived`,
        );
      }
    }
  }

  // 3A / migration 0032. `document_line_item_fk`, `_warehouse_fk`, `_lot_fk` and `_unit_fk` are all
  // composite on `(tenant_id, x)` and bound the TENANT only, exactly as the account key does, so each id
  // is checked against THIS company here too. Without it a caller authorised for company A puts company
  // B's item, warehouse, lot or unit on a line — the class AGENTS.md names, and the class the Phase 2
  // review pass found three of. Archived rows are refused for the three tables that have `archived_at`;
  // `app.unit_of_measure` has none (contracts §4.6.1) and is checked for company alone.
  const distinctIds = (field: "itemId" | "warehouseId" | "lotId" | "unitId"): string[] => [
    ...new Set(
      lines.map((line) => line[field]).filter((value): value is string => value !== undefined),
    ),
  ];
  const assertLive = (
    field: "itemId" | "warehouseId" | "lotId" | "unitId",
    label: string,
    live: ReadonlySet<string>,
  ): void => {
    for (const line of lines) {
      const id = line[field];
      if (id !== undefined && !live.has(id)) {
        throw new AppError(
          "ERR_NOT_FOUND",
          `line ${line.lineNo}: no live ${label} ${id} in company ${companyId}`,
        );
      }
    }
  };

  const itemIds = distinctIds("itemId");
  if (itemIds.length > 0) {
    const rows = await tx<{ id: string }[]>`
      select id from app.item
       where company_id = ${companyId} and archived_at is null and id = any(${itemIds}::uuid[])`;
    assertLive("itemId", "item", new Set(rows.map((row) => row.id)));
  }
  const warehouseIds = distinctIds("warehouseId");
  if (warehouseIds.length > 0) {
    const rows = await tx<{ id: string }[]>`
      select id from app.warehouse
       where company_id = ${companyId} and archived_at is null and id = any(${warehouseIds}::uuid[])`;
    assertLive("warehouseId", "warehouse", new Set(rows.map((row) => row.id)));
  }
  const lotIds = distinctIds("lotId");
  if (lotIds.length > 0) {
    const rows = await tx<{ id: string }[]>`
      select id from app.lot
       where company_id = ${companyId} and archived_at is null and id = any(${lotIds}::uuid[])`;
    assertLive("lotId", "lot", new Set(rows.map((row) => row.id)));
  }
  const unitIds = distinctIds("unitId");
  if (unitIds.length > 0) {
    const rows = await tx<{ id: string }[]>`
      select id from app.unit_of_measure
       where company_id = ${companyId} and id = any(${unitIds}::uuid[])`;
    assertLive("unitId", "unit of measure", new Set(rows.map((row) => row.id)));
  }

  // {"<dimension_type.code>": "<dimension_value.id>"} — each value must be a live value of a type with that
  // code in THIS company. BRANCH is never a line dimension (0011); the header carries it and the evaluator
  // overwrites whatever a client put here, but a value of another company's type is refused all the same.
  const pairs = lines.flatMap((line) =>
    Object.entries(line.dimensions).map(([code, valueId]) => ({
      lineNo: line.lineNo,
      code,
      valueId,
    })),
  );
  if (pairs.length === 0) return;
  const found = await tx<{ code: string; id: string }[]>`
    select t.code, v.id
      from app.dimension_value v
      join app.dimension_type t on t.id = v.dimension_type_id
     where t.company_id = ${companyId}
       and v.archived_at is null
       and (t.code, v.id) in (select * from unnest(${pairs.map((pair) => pair.code)}::text[],
                                                   ${pairs.map((pair) => pair.valueId)}::uuid[]))`;
  const live = new Set(found.map((row) => `${row.code}|${row.id}`));
  for (const pair of pairs) {
    if (!live.has(`${pair.code}|${pair.valueId}`)) {
      throw new AppError(
        "ERR_VALIDATION_FAILED",
        `line ${pair.lineNo}: ${pair.valueId} is not a live value of dimension ${pair.code} in company ${companyId}`,
      );
    }
  }
}

/** The header's branch: a live value of THIS company's BRANCH dimension type, not merely any dimension_value
 *  in the tenant (which is all `document_branch_fk` checks). */
async function assertBranchBelongs(tx: Tx, companyId: string, branchId: string): Promise<void> {
  const [branch] = await tx<{ id: string }[]>`
    select v.id
      from app.dimension_value v
      join app.dimension_type t on t.id = v.dimension_type_id
     where v.id = ${branchId} and t.company_id = ${companyId} and t.code = 'BRANCH'
       and v.archived_at is null`;
  if (!branch) {
    throw new AppError("ERR_NOT_FOUND", `no branch ${branchId} in company ${companyId}`);
  }
}

/** The header's party: a live party of THIS company. `document_party_fk` (0018) is tenant-composite only,
 *  so without this a party of a sibling company — and, through the policy, that company's receivable or
 *  payable account — would be accepted. 404 like the branch: a party id the caller may not see is not
 *  confirmed to exist by a 403. */
async function assertPartyBelongs(tx: Tx, companyId: string, partyId: string): Promise<void> {
  const [party] = await tx<{ id: string }[]>`
    select id from app.party where id = ${partyId} and company_id = ${companyId} and archived_at is null`;
  if (!party) {
    throw new AppError("ERR_NOT_FOUND", `no party ${partyId} in company ${companyId}`);
  }
}

/** `tx({ … })` is postgres.js's own helper for a parameterised column/value list — every value is bound,
 *  no identifier is built from a string (contracts §3.3). `cost` is absent on purpose: it is the costing
 *  engine's column (3B), never a client's. */
const lineWriteColumns = (
  tx: Tx,
  tenantId: string,
  companyId: string,
  documentId: string,
  line: LineWrite,
) =>
  tx({
    tenant_id: tenantId,
    company_id: companyId,
    document_id: documentId,
    line_no: line.lineNo,
    description: line.description ?? null,
    account_id: line.accountId ?? null,
    kind: line.kind,
    debit: line.debit,
    credit: line.credit,
    // Omitted with an entered pair present, `quantity` is what migration 0032's trigger derives; supplied
    // and inconsistent with that pair, the trigger refuses the row rather than overwriting it (LEGACY-066).
    quantity: line.quantity ?? null,
    unit_price: line.unitPrice ?? null,
    item_id: line.itemId ?? null,
    tax_code_id: line.taxCodeId ?? null,
    warehouse_id: line.warehouseId ?? null,
    lot_id: line.lotId ?? null,
    unit_id: line.unitId ?? null,
    unit_quantity: line.unitQuantity ?? null,
    // counted_quantity / expected_quantity are never written here — see DocumentLineInput. Their sole
    // writers are snapshotCountSheet, recordCounts and draftTransferReceipt.
    discount: line.discount,
    amount: line.amount,
    tax_amount: "0.0000",
    total_incl_tax: "0.0000",
    // `tx.json`, never `JSON.stringify`: the column is jsonb, postgres.js serialises a jsonb-typed
    // parameter itself, and a pre-stringified value would be stored as a JSON string scalar (b985eb0).
    dimensions: tx.json(line.dimensions as never),
    custom_fields: tx.json(line.customFields as never),
  });

async function insertLines(
  tx: Tx,
  tenantId: string,
  companyId: string,
  documentId: string,
  lines: readonly LineWrite[],
): Promise<void> {
  await assertLinesBelong(tx, companyId, lines);
  for (const line of lines) {
    await tx`insert into app.document_line ${lineWriteColumns(tx, tenantId, companyId, documentId, line)}`;
  }
}

async function readDocument(
  tx: Tx,
  companyId: string,
  documentId: string,
): Promise<ReturnType<typeof toDocument>> {
  const [head] = await tx<HeaderRow[]>`
    select ${header(tx)} from app.document d join app.document_type t on t.id = d.document_type_id
     where d.id = ${documentId} and d.company_id = ${companyId}`;
  if (!head) {
    throw new AppError("ERR_NOT_FOUND", `no document ${documentId} in company ${companyId}`);
  }
  // Every row, unfiltered: PUT …/lines deletes what it replaces (0023's grant), so there is no tombstone to
  // hide and this read agrees with loadSnapshot, the print model and reverseDocument, which never filtered.
  const lines = await tx<LineRow[]>`select ${lineColumns(tx)} from app.document_line
     where document_id = ${documentId}
     order by line_no`;
  // Code review 2, S1. `line.cost` is the costing engine's figure (3B) — the COGS of an issue — and this read
  // is gated by `accounting.journal.create`, which the clerk holds while spec:2158 says the clerk "May not:
  // … see costs". So it is a FIELD read: every line's cost is null unless the caller holds
  // `inventory.cost.read` at the document's own branch. `DocumentSchema.lines[].cost` is already nullable.
  const [sight] = await tx<{ ok: boolean }[]>`
    select app.actor_has(${PERMISSION["inventory.cost.read"]}, ${companyId}::uuid,
                         ${head.branch_id}::uuid) as ok`;
  return toDocument(
    head,
    sight?.ok === true ? lines : lines.map((line) => ({ ...line, cost: null })),
  );
}
