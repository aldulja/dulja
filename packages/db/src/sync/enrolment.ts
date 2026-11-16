import { createHash, randomBytes } from "node:crypto";
import type { Sql } from "postgres";
import type { TenantContext } from "../with-tenant";
import type { ResolvedEnrolment } from "./identity";

export type SyncErrorCode =
  | "ERR_CONFLICT_REFERENCE"
  // `createEnrolment` raises it for a terminal code another live or redeemed enrolment holds (migration 0060's
  // exclusion). 0B's own row (409), as the `unique (company_id, terminal_code)` it replaced answered.
  | "ERR_CONFLICT_UNIQUE"
  | "ERR_TERMINAL_SIGNATURE_INVALID"
  | "ERR_TERMINAL_REVOKED"
  | "ERR_TERMINAL_ENROLMENT_INVALID"
  | "ERR_SYNC_CURSOR_INVALID"
  | "ERR_SYNC_MESSAGE_UNSUPPORTED"
  | "ERR_VALIDATION_FAILED"
  // `verifyAuthority` (T11) raises it for a cashier who holds neither the code nor an override that rescues
  // it. It is 0B's own row (§4.2.4's table, 403) and not a new code — which is the whole point of this union
  // being a SUBSET: `apps/api/src/problem.ts` maps `SyncError` by `code` and needs no branch for this one.
  | "ERR_RBAC_FORBIDDEN"
  | "ERR_NOT_FOUND"
  | "ERR_POS_LIMIT_EXCEEDED"
  | "ERR_OVERRIDE_NOT_AUTHORISED"
  | "ERR_SYNC_TICKET_REJECTED";

/** `packages/db` may not import `AppError` (§3.1 pins it to @dulja/domain), so this is 1A's `PostingError`
 *  pattern applied again: a literal SUBSET of `ErrCode`, never a new code. */
export class SyncError extends Error {
  constructor(
    readonly code: SyncErrorCode,
    readonly detail: string,
  ) {
    super(detail);
    this.name = "SyncError";
  }
}

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"; // Crockford-ish: no 0/1/8/9, so a code read aloud is unambiguous
export function mintEnrolmentCode(): string {
  const bytes = randomBytes(32);
  let out = "";
  for (const b of bytes) out += BASE32[b % 32];
  return out; // 32 chars × 5 bits = 160 bits of selection from 256 bits of entropy
}
export function hashEnrolmentCode(code: string): Buffer {
  return createHash("sha256").update(code, "utf8").digest();
}

export interface CreateEnrolmentInput {
  companyId: string;
  branchId: string;
  name: string;
  terminalCode: string;
  ttlMinutes?: number;
}
export interface CreatedEnrolment {
  enrolmentId: string;
  code: string;
  expiresAt: string;
}

/** Migration 0060's terminal-code reservation: an exclusion, so its violation is 23P01, not 23505. */
const TERMINAL_CODE_HELD = "terminal_enrolment_terminal_code_excl";
const holdsTerminalCode = (e: unknown): boolean => {
  const pg = e as { code?: unknown; constraint_name?: unknown };
  return pg.code === "23P01" && pg.constraint_name === TERMINAL_CODE_HELD;
};

/**
 * Returns the plaintext code ONCE. Only its hash is stored (migration 0060, spec:1322).
 *
 * The terminal code is reserved by the INSERT itself, not by a prior read: migration 0060's exclusion refuses
 * it while another enrolment for the code is live or redeemed, and admits it once that one expired unredeemed
 * (PR 12 review, finding 14). A read-then-insert would race, and under RLS would not even see an enrolment in
 * a branch the caller cannot.
 */
export async function createEnrolment(
  tx: Sql,
  ctx: TenantContext,
  input: CreateEnrolmentInput,
): Promise<CreatedEnrolment> {
  await assertBranch(tx, input.companyId, input.branchId);
  const code = mintEnrolmentCode();
  const ttl = input.ttlMinutes ?? 60;
  try {
    const [row] = await tx<{ id: string; expires_at: string }[]>`
      insert into app.terminal_enrolment (tenant_id, company_id, branch_id, code_hash, name, terminal_code, expires_at)
      values (${ctx.tenantId}, ${input.companyId}, ${input.branchId}, ${hashEnrolmentCode(code)},
              ${input.name}, ${input.terminalCode}, now() + make_interval(mins => ${ttl}))
      returning id, expires_at`;
    return { enrolmentId: row!.id, code, expiresAt: row!.expires_at };
  } catch (e) {
    if (holdsTerminalCode(e))
      throw new SyncError(
        "ERR_CONFLICT_UNIQUE",
        `terminal code ${input.terminalCode} is held by a live enrolment or an enrolled terminal in this company`,
      );
    throw e;
  }
}

export interface RedeemedTerminal {
  terminalId: string;
  principalId: string;
  companyId: string;
  branchId: string;
  code: string;
}

/**
 * The ONE place a `pos_terminal` row and its `terminal` principal are created. Production redemption and the
 * `seedTerminal` fixture both call it, so a fixture terminal and a real one can never diverge — which matters
 * because R8 (spec:2179) is trigger-enforced in both directions and a fixture that skipped the branch row
 * would make every branch-scoped test pass for the wrong reason.
 *
 * Plan 0A's convention: insert the `principal` **without `RETURNING`** and its `membership` in the same
 * transaction (plan0A:837).
 */
export async function createTerminal(
  tx: Sql,
  input: {
    companyId: string;
    branchId: string;
    name: string;
    code: string;
    devicePublicKey: Buffer;
  },
): Promise<RedeemedTerminal> {
  await assertBranch(tx, input.companyId, input.branchId);
  const [ids] = await tx<{ terminal_id: string; principal_id: string; tenant_id: string }[]>`
    select uuidv7() as terminal_id, uuidv7() as principal_id, app.current_tenant() as tenant_id`;
  const { terminal_id: terminalId, principal_id: principalId, tenant_id: tenantId } = ids!;

  await tx`insert into app.principal (id, kind, auth_subject, display_name)
           values (${principalId}, 'terminal', ${`terminal:${terminalId}`}, ${input.name})`;
  await tx`insert into app.membership (tenant_id, principal_id) values (${tenantId}, ${principalId})`;
  await tx`insert into app.pos_terminal (id, tenant_id, company_id, branch_id, principal_id, name, code, device_public_key)
           values (${terminalId}, ${tenantId}, ${input.companyId}, ${input.branchId}, ${principalId},
                   ${input.name}, ${input.code}, ${input.devicePublicKey})`;

  // R8 (spec:2179): the role code is the fixed literal `pos_terminal` that `app.assert_assignment_kind`
  // checks in BOTH directions — a terminal may hold only this role, and this role only a terminal.
  const [role] = await tx<{ id: string }[]>`select id from app.role where code = 'pos_terminal'`;
  if (!role)
    throw new SyncError(
      "ERR_NOT_FOUND",
      "the pos_terminal role is not seeded in this tenant — run `bun run seed --only roles`",
    );
  await tx`insert into app.role_assignment (tenant_id, principal_id, role_id, company_id)
           values (${tenantId}, ${principalId}, ${role.id}, ${input.companyId})`;
  await tx`insert into app.role_assignment_branch (tenant_id, principal_id, role_id, company_id, branch_id)
           values (${tenantId}, ${principalId}, ${role.id}, ${input.companyId}, ${input.branchId})`;

  return {
    terminalId,
    principalId,
    companyId: input.companyId,
    branchId: input.branchId,
    code: input.code,
  };
}

/**
 * Spends the enrolment and creates the terminal in one transaction. The `where redeemed_at is null` on the
 * update is the race guard: two tills presenting one code at the same instant both reach here, and exactly
 * one `update` reports a row (spec:1322 "the till redeems it ONCE").
 */
export async function redeemEnrolment(
  tx: Sql,
  enrolment: ResolvedEnrolment,
  devicePublicKey: Buffer,
): Promise<RedeemedTerminal> {
  // Redeeming widens the enrolment's hold on its terminal code to for ever (migration 0060). The one way that
  // can collide is a redemption whose transaction began just before expiry racing a re-issue of the same code
  // that began just after it; whichever commits second loses, and for this side that means the code expired.
  const claimed = await tx<{ name: string; terminal_code: string }[]>`
    update app.terminal_enrolment set redeemed_at = now()
     where id = ${enrolment.enrolmentId} and redeemed_at is null and expires_at > now()
     returning name, terminal_code`.catch((e: unknown) => {
    if (holdsTerminalCode(e)) return [];
    throw e;
  });
  if (claimed.length === 0)
    throw new SyncError("ERR_TERMINAL_ENROLMENT_INVALID", "that enrolment code is not valid");

  const terminal = await createTerminal(tx, {
    companyId: enrolment.companyId,
    branchId: enrolment.branchId,
    name: claimed[0]!.name,
    code: claimed[0]!.terminal_code,
    devicePublicKey,
  });
  await tx`update app.terminal_enrolment set terminal_id = ${terminal.terminalId} where id = ${enrolment.enrolmentId}`;
  return terminal;
}

async function assertBranch(tx: Sql, companyId: string, branchId: string): Promise<void> {
  const [row] = await tx<{ id: string }[]>`
    select v.id from app.dimension_value v join app.dimension_type t on t.id = v.dimension_type_id
     where v.id = ${branchId} and t.company_id = ${companyId} and t.code = 'BRANCH' and v.archived_at is null`;
  if (!row) throw new SyncError("ERR_NOT_FOUND", "the branch is not in this company");
}
