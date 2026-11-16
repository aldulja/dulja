import type { MiddlewareHandler } from "hono";
import { AppError } from "@dulja/contracts";
import { PERMISSION, type PermissionCode } from "@dulja/contracts/permissions";
import { getAttachment, type DocumentTypeModule } from "@dulja/db";
import type { AppEnv } from "../context";
import { assertRoleInCompany, markPermissionGate, markWriteFreeGate } from "./require-permission";

/**
 * The §4.5.8 download map, built ONE MODULE AT A TIME by the slice that introduces the code.
 * At 2C only the accounting ledger read code existed in the catalogue; 3A seeded the inventory codes
 * (migration 0033) and added its row below. The remaining one-line additions are owned by:
 *   6D  pos       → the pos report read code
 *   8B  hr        → the hr payroll read code
 * A module with no row DENIES. That is the safe direction and needs no compensating work: a `pos` or `hr`
 * document type cannot exist before those slices either.
 * Each of those three additions is ONE LINE: `require-attachment-read.test.ts` asserts deny-by-absence as a
 * property and never pins the key list, so adding a row falsifies nothing there. Add your row and your own
 * positive case; do not rewrite the three cases already in that file.
 */
export const MODULE_READ_CODE: Readonly<Partial<Record<DocumentTypeModule, PermissionCode>>> = {
  pos: PERMISSION["pos.report.read"],
  accounting: PERMISSION["accounting.ledger.read"],
  // 3A — §4.5.8. This is the MODULE row: the gate on an attachment of an `inventory`-module DOCUMENT.
  // A LOT attachment is a different rule with a different code; see the branch in `requireAttachmentRead`.
  // Deliberately NOT merged with 2B's same-named local map in `routes/accounting/documents.ts` (hazard 32).
  inventory: PERMISSION["inventory.stock.read"],
  // 8B — §4.5.8, §4.14: PAYROLL is `hr`, and so are 8C's PAYROLL_PAYMENT and EMPLOYEE_ADVANCE. Their attachments
  // are the bank batch and the advance authorisation, both carrying per-employee pay, and the accounting code
  // there would open exactly the side channel test 32 exists to close.
  hr: PERMISSION["hr.payroll.read"],
};

/**
 * §4.5.8's lot rule, which is NOT the inventory module row above: a lot's certificate is catalogue data,
 * and `inventory.item.read` is the code that reads the catalogue. Named here so the download gate, the
 * list route and `assertRouteGates` all read one constant.
 */
export const LOT_READ_CODE: PermissionCode = PERMISSION["inventory.item.read"];

/** Every code either branch of `requireAttachmentRead` may evaluate — what the gate is marked with. */
const ATTACHMENT_READ_CODES: readonly string[] = [
  ...Object.values(MODULE_READ_CODE),
  LOT_READ_CODE,
];

/** Loads the attachment named by `:attachmentId`, resolves its module's read code, evaluates
 *  `app.actor_has(code, company_id, branch_id)` at the owning document's branch and stores the row on the
 *  context under `attachment`. Marked as a gate over the codes the map may evaluate, so `assertRouteGates`
 *  sees the route as gated. */
export function requireAttachmentRead(): MiddlewareHandler<AppEnv> {
  const handler: MiddlewareHandler<AppEnv> = async (c, next) => {
    const companyId = c.req.param("companyId")!;
    const attachmentId = c.req.param("attachmentId")!;

    const found = await c.var.withTenant(async (tx) => {
      // S3 (code review 2): the company first. Asked after the lookup, a caller with no role in the path
      // company got 403 for a real attachment id and 404 for a random one.
      await assertRoleInCompany(tx, c.var.ctx.actorId, companyId);
      return getAttachment(tx, attachmentId);
    });
    // RLS has already reduced app.attachment to the caller's tenant, so an invisible row and a missing row
    // are indistinguishable here — which is the point: 404 never reveals cross-tenant existence.
    if (!found || found.row.companyId !== companyId) {
      throw new AppError(
        "ERR_NOT_FOUND",
        `attachment ${attachmentId} is not visible in company ${companyId}`,
      );
    }

    // §4.5.8: "a lot attachment → inventory.item.read", evaluated BEFORE the module lookup. A lot has no
    // document and therefore no module and no branch, so the company alone bounds it — and `getAttachment`
    // would otherwise hand a lot row the `accounting` fallback, which is the wrong gate entirely.
    if (found.row.lotId !== null) {
      const [ok] = await c.var.withTenant(
        (tx) => tx<{ ok: boolean }[]>`
          select app.actor_has(${LOT_READ_CODE}, ${found.row.companyId}, null) as ok`,
      );
      if (!ok?.ok) {
        throw new AppError(
          "ERR_RBAC_FORBIDDEN",
          `downloading attachment ${attachmentId} of a lot requires ${LOT_READ_CODE}`,
        );
      }
      c.set("attachment", found);
      await next();
      return;
    }

    const code = MODULE_READ_CODE[found.module];
    if (!code) {
      throw new AppError(
        "ERR_RBAC_FORBIDDEN",
        `attachments of ${found.module} documents cannot be downloaded yet: the ${found.module} read code is introduced by a later slice (contracts §4.5.8)`,
      );
    }

    // At the owning document's branch, exactly as the print and events gates ask: a reader whose assignment
    // is restricted to one branch may download what they may print.
    const [allowed] = await c.var.withTenant(
      (tx) => tx<{ ok: boolean }[]>`
        select app.actor_has(${code}, ${found.row.companyId}, ${found.branchId}) as ok`,
    );
    if (!allowed?.ok) {
      throw new AppError(
        "ERR_RBAC_FORBIDDEN",
        `downloading attachment ${attachmentId} requires ${code}`,
      );
    }

    c.set("attachment", found);
    await next();
  };
  return markPermissionGate(handler, ATTACHMENT_READ_CODES);
}

/**
 * Membership plus the read code of the module of the document's type — contracts §4.5.4's stated rule for
 * a document read ("membership + the type's module read code"), applied to `GET …/events` and to printing
 * alike, from this ONE map. The map is §4.5.8's and is built one module at a time: at 2C only `accounting`
 * has a row, and every other module value is denied (`ERR_RBAC_FORBIDDEN`) rather than defaulted. Loads the
 * document named by `:documentId`, evaluates the code at the document's branch and stores its module under
 * `documentModule`.
 *
 * `writeFree: true` marks the gate with `markWriteFreeGate` for the print route — a POST gated by a READ
 * code, which the boot check admits only for a route `REPLAY_BY_RERUN` also declares write-free.
 * `writeFree: false` is the ordinary `markPermissionGate` for a GET.
 */
export function requireDocumentModuleRead(opts: { writeFree: boolean }): MiddlewareHandler<AppEnv> {
  const handler: MiddlewareHandler<AppEnv> = async (c, next) => {
    const companyId = c.req.param("companyId")!;
    const documentId = c.req.param("documentId");
    if (!documentId) throw new AppError("ERR_NOT_FOUND", "documentId is required");

    const found = await c.var.withTenant(async (tx) => {
      // S3 (code review 2): the company first, before the document is read — otherwise a caller with no
      // role in the path company read "needs <code> at branch <id>" for a real id and 404 for a random one.
      await assertRoleInCompany(tx, c.var.ctx.actorId, companyId);
      const [row] = await tx<{ module: DocumentTypeModule; companyId: string; branchId: string }[]>`
        select dt.module, d.company_id as "companyId", d.branch_id as "branchId"
          from app.document d
          join app.document_type dt on dt.id = d.document_type_id
         where d.id = ${documentId} and d.company_id = ${companyId}`;
      if (!row) return null;
      const code = MODULE_READ_CODE[row.module];
      if (!code) return { row, allowed: false as const };
      const [ok] = await tx<{ allowed: boolean }[]>`
        select app.actor_has(${code}, ${row.companyId}, ${row.branchId}) as allowed`;
      return { row, allowed: ok?.allowed === true };
    });

    // A document another tenant owns is invisible under RLS and answers 404 — never a 403, which would
    // confirm that it exists (§4.2.4's ERR_NOT_FOUND note). A caller from another tenant never reaches this
    // line: it holds no role in the path company, and `assertRoleInCompany` refused it above.
    if (!found) {
      throw new AppError(
        "ERR_NOT_FOUND",
        `document ${documentId} not found in company ${companyId}`,
      );
    }
    if (!found.allowed) {
      const code = MODULE_READ_CODE[found.row.module];
      throw new AppError(
        "ERR_RBAC_FORBIDDEN",
        code === undefined
          ? `module ${found.row.module} has no read code at this release; its slice adds the row (contracts §4.5.8)`
          : `reading a '${found.row.module}' document needs ${code} at branch ${found.row.branchId}`,
      );
    }
    c.set("documentModule", found.row.module);
    await next();
  };
  const codes = Object.values(MODULE_READ_CODE);
  return opts.writeFree ? markWriteFreeGate(handler, codes) : markPermissionGate(handler, codes);
}
