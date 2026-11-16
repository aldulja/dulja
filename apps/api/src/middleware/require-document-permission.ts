import type { MiddlewareHandler } from "hono";
import type { PostingPolicy } from "@dulja/domain";
import { resolvePolicy } from "@dulja/db";
import { AppError } from "@dulja/contracts";
import { PERMISSION, type PermissionCode } from "@dulja/contracts/permissions";
import type { AppEnv } from "../context";
import { assertRoleInCompany, markPermissionGate } from "./require-permission";

/** contracts §4.5.4. All six stages are mapped here (amendment A4): 2A reaches create/issue/post/void, and
 *  2B's state machine reaches submit/approve without editing this file. */
export type DocumentStage = "create" | "submit" | "approve" | "issue" | "post" | "void";

/** create/submit → approval.create ?? approval.post · approve → approval.approve ?? approval.post ·
 *  issue/post/void → approval.post (contracts §4.5.4). `approval.post` is required by the schema, so every
 *  branch terminates in a code and none can fall open. Returns `string`, not `PermissionCode`: a policy may
 *  legitimately name a code whose slice has not seeded it yet, and narrowing the return would make that a
 *  compile error instead of a 403 (the same reading 2B's `stageCode` export takes). */
export function stageCode(stage: DocumentStage, approval: PostingPolicy["approval"]): string {
  const post = approval.post;
  switch (stage) {
    case "create":
    case "submit":
      return approval.create ?? post;
    case "approve":
      return approval.approve ?? post;
    case "issue":
    case "post":
    case "void":
      return post;
  }
}

/**
 * Resolves the policy the gate applies from the DOCUMENT when the path names one (`:documentId` — replacing
 * a draft's lines, deleting it, moving it), and from the body's `documentTypeCode`, `effectiveDate` and
 * `branchId` only when it does not (the create route, where no row exists yet). Then maps the stage to a
 * code (contracts §4.5.4) and calls `app.actor_has(code, company_id, branch_id)` inside `c.var.withTenant`
 * — the document's branch, or the branch the body names, so a principal whose assignment is restricted to
 * one branch can draft there (`actor_has` with a NULL branch demands company-wide authority). 403
 * `ERR_RBAC_FORBIDDEN`; 404 `ERR_NOT_FOUND` when the document or the type is invisible. Pre-flight ONLY
 * (spec:2173): 2B's BEFORE UPDATE OF status trigger is the control. Before either lookup it asks whether the
 * caller holds any role in the path company (`assertRoleInCompany`, code review 2 S3): a caller outside the
 * company gets one 403 for every id, so the 403/404 split is only ever seen by a member.
 *
 * The choice is made on the PATH and never on the stage: an earlier version read the body whenever the
 * stage was `create`, so `PUT …/{id}/lines` (whose body carries only `lines`) and `DELETE …/{id}` (which
 * carries no body) resolved a type named `""` and answered 404 on every call.
 *
 * `options.branch` replaces only the BRANCH asked about, never the policy or the stage: the two transfer
 * sub-paths draft a document whose branch is neither the path document's nor one the body names (ADR 0043's
 * amendment, accepted 2026-11-04), so each says where its draft's branch comes from (`GateBranch`).
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The tagged-template handle `c.var.withTenant` hands its callback. */
type Tx = Parameters<Parameters<AppEnv["Variables"]["withTenant"]>[0]>[0];

/**
 * Where a route's gate finds the branch the document it drafts will CARRY, when that is neither the path
 * document's own branch nor a `branchId` in the body — the two transfer sub-paths (ADR 0043's amendment,
 * accepted by the owner 2026-11-04): a dispatch carries its source warehouse's branch, a receipt its
 * corridor's. Called inside the gate's own transaction, after the company check and under the caller's own row
 * policies; `fallback` is the branch the gate would otherwise ask about. `null` asks for company-wide
 * authority, which is what a branch the caller cannot resolve must cost.
 */
export type GateBranch = (
  tx: Tx,
  at: {
    companyId: string;
    documentId: string | null;
    body: Record<string, unknown>;
    fallback: string | null;
  },
) => Promise<string | null>;

export function requireDocumentPermission(
  stage: DocumentStage,
  options: { branch?: GateBranch } = {},
): MiddlewareHandler<AppEnv> {
  const handler: MiddlewareHandler<AppEnv> = async (c, next) => {
    const companyId = c.req.param("companyId")!;
    // `null` rather than `undefined`: postgres.js binds null and refuses an undefined parameter.
    const documentId = c.req.param("documentId") ?? null;

    const resolved = await c.var.withTenant(async (tx) => {
      // S3 (code review 2): the company first, before the type or the document is read, so a caller with
      // no role in the path company learns nothing about what exists in it — both branches below.
      await assertRoleInCompany(tx, c.var.ctx.actorId, companyId);
      if (documentId === null) {
        // Hono caches the parsed body, so the handler's own `c.req.json()` does not parse twice.
        const parsed: unknown = await c.req.json().catch(() => ({}));
        const body = (typeof parsed === "object" && parsed !== null ? parsed : {}) as {
          documentTypeCode?: unknown;
          effectiveDate?: unknown;
          branchId?: unknown;
        } & Record<string, unknown>;
        const code = typeof body.documentTypeCode === "string" ? body.documentTypeCode : "";
        const effectiveDate = typeof body.effectiveDate === "string" ? body.effectiveDate : "";
        const [type] = await tx<{ id: string }[]>`
          select id from app.document_type
           where company_id = ${companyId} and code = ${code} and archived_at is null`;
        if (!type || effectiveDate === "") {
          throw new AppError(
            "ERR_NOT_FOUND",
            `no document type ${code || "(none given)"} in company ${companyId}`,
          );
        }
        const { definition } = await resolvePolicy(tx, type.id, effectiveDate);
        // The branch the draft will carry. Whether it is a live branch of THIS company is the handler's
        // check (`assertBranchBelongs`); a value that is not even a uuid is refused there by Zod. Here it
        // only decides which branch's authority is asked about.
        const named =
          typeof body.branchId === "string" && UUID.test(body.branchId) ? body.branchId : null;
        const branchId =
          options.branch === undefined
            ? named
            : await options.branch(tx, { companyId, documentId: null, body, fallback: named });
        return { policy: definition, branchId };
      }

      const [doc] = await tx<
        { document_type_id: string; effective_date: string; branch_id: string }[]
      >`
        select document_type_id, to_char(effective_date, 'YYYY-MM-DD') as effective_date, branch_id
          from app.document where id = ${documentId} and company_id = ${companyId}`;
      if (!doc)
        throw new AppError("ERR_NOT_FOUND", `no document ${documentId} in company ${companyId}`);
      const { definition } = await resolvePolicy(tx, doc.document_type_id, doc.effective_date);
      const branchId =
        options.branch === undefined
          ? doc.branch_id
          : await options.branch(tx, { companyId, documentId, body: {}, fallback: doc.branch_id });
      return { policy: definition, branchId };
    });

    const code = stageCode(stage, resolved.policy.approval);
    const allowed = await c.var.withTenant(async (tx) => {
      const [row] = await tx<{ ok: boolean }[]>`
        select app.actor_has(${code}, ${companyId}::uuid, ${resolved.branchId}::uuid) as ok`;
      return row!.ok;
    });
    if (!allowed) {
      throw new AppError(
        "ERR_RBAC_FORBIDDEN",
        `${code} is required to ${stage} a ${resolved.policy.documentType} in company ${companyId}`,
      );
    }
    await next();
  };
  // The gate mark `assertRouteGates` reads: a route under this middleware is gated, by any of the codes a
  // seeded policy may name (§4.5.4's DOCUMENT_STAGE_CODES is initialised from this same constant).
  return markPermissionGate(handler, POLICY_RESOLVED_CODES);
}

/** Referenced so the `permission-catalogue` lint (§3.6.3) sees the codes DOCUMENT_STAGE_CODES holds even
 *  though every gate above is resolved from data, which no source scan can see. `PERMISSION` is the
 *  catalogue's own identity map (§4.2.5). At 2A the only seeded type is JOURNAL, whose policy names
 *  `accounting.journal.post` alone; `accounting.journal.create` stays here because the documents module's
 *  static gate — its only other source reference — is gone, and the bidirectional check needs one. Every
 *  type-seeding slice appends its `approval.*` codes here in the PR that ships its policy file. */
export const POLICY_RESOLVED_CODES: readonly PermissionCode[] = [
  PERMISSION["accounting.journal.create"],
  PERMISSION["accounting.journal.post"],
  // 3C — the four purchasing codes the PURCHASE_ORDER, SHIPMENT, GOODS_RECEIPT and PURCHASE_RETURN
  // policies name in their `approval` blocks (contracts §3.6.2, §4.5.4). §4.5.4 names 3C "the first slice
  // that genuinely extends it": without these four the `permission-catalogue` lint fails on this slice,
  // because a code gated only from policy data has no other source reference to find.
  PERMISSION["accounting.purchase.create"],
  PERMISSION["accounting.purchase.post"],
  PERMISSION["inventory.receipt.create"],
  PERMISSION["inventory.receipt.post"],
  // 3D (contracts §3.6.2). Each is the `approval.create` / `.post` / `.approve` of one of the six
  // seed-pack policies this slice ships — SALES_ORDER, DELIVERY_ORDER, TRANSFER, TRANSFER_RECEIPT,
  // STOCK_COUNT and EXPIRY_WRITE_OFF — so the gate resolves it from posting_policy at request time and
  // no route names it at compile time. Without this the `permission-catalogue` lint (§3.6.3) fails on
  // six catalogue codes with no source reference: policy JSON is data, and no source scan sees it.
  PERMISSION["inventory.transfer.create"],
  PERMISSION["inventory.transfer.post"],
  PERMISSION["inventory.count.create"],
  PERMISSION["inventory.adjustment.create"],
  PERMISSION["inventory.adjustment.approve"],
  PERMISSION["accounting.sales.create"],
  // 4A (contracts §3.6.2). The six `approval` codes the SALES_INVOICE, SALES_CREDIT_NOTE, PURCHASE_INVOICE,
  // PURCHASE_CREDIT_NOTE, RECEIPT and PAYMENT policies name (4A Tasks 5, 7, 8 and 10 ship the files). The
  // seventh 4A code, the credit-limit override, is deliberately NOT here: no policy names it as an approval
  // code. It is one of 2B's `OverrideCode` members (packages/db/src/posting/lifecycle.ts), which is its
  // source reference, and 4A Task 3's party-handler pre-flight is where it is evaluated. It is not spelled
  // out in this comment on purpose: the `permission-catalogue` lint counts any occurrence as a reference.
  PERMISSION["accounting.sales.post"],
  PERMISSION["accounting.receipt.create"],
  PERMISSION["accounting.receipt.post"],
  PERMISSION["accounting.payment.create"],
  PERMISSION["accounting.payment.approve"],
  PERMISSION["accounting.payment.post"],
  // 6A: `POS_TICKET.approval.post`. The route that evaluates it is `POST /v1/sync/tickets`, which resolves it
  // through `postDocument`, not through `requireDocumentPermission`.
  PERMISSION["pos.sync.push"],
  // 8B (contracts §3.6.2, §4.12.2): the PAYROLL policy's approval.create / .approve / .post. Resolved from
  // posting_policy at request time, so no route names them at compile time.
  PERMISSION["hr.payroll.prepare"],
  PERMISSION["hr.payroll.approve"],
  PERMISSION["hr.payroll.post"],
  // 8C (contracts §3.6.2, round 18 B8): PAYROLL_PAYMENT's and EMPLOYEE_ADVANCE's approval.create. Their approve
  // and post codes are 4A's accounting.payment.approve / .post, already above.
  PERMISSION["hr.payroll.pay"],
  PERMISSION["hr.advance.create"],
];
