import { readFile, writeFile } from "node:fs/promises";
import type { Sql } from "postgres";
import {
  checkAccountBalanceProjection,
  checkAuditChain,
  trialBalanceFingerprint,
  withTenant,
  type TenantContext,
} from "@dulja/db";
import { uuidv7, type Db } from "@dulja/db/test";

/** What the live system reported at the recovery target. Written as JSON between the two phases. */
export interface DrillCapture {
  /** The recovery target. `now()` is transaction start time, so it precedes every figure below. */
  readonly capturedAt: string;
  readonly tenantId: string;
  /** The principal the capture ran as. Carried so the verify phase needs no extra environment. */
  readonly actorId: string;
  readonly companyId: string;
  readonly fiscalPeriodId: string;
  /** trialBalanceFingerprint over the company's account_balance rows — a hex sha256, never a number. */
  readonly fingerprint: string;
  /** ledger_entry rows visible at capture. A mismatch on restore means a write raced the capture. */
  readonly postings: number;
  readonly auditHeadSeq: number;
  readonly auditHeadHash: string;
}

export interface DrillVerdict {
  readonly fingerprintMatches: boolean;
  readonly projectionMismatches: number;
  readonly chain: {
    readonly rows: number;
    readonly brokenLinks: number;
    readonly badHashes: number;
    readonly headSeq: number;
  };
  readonly postings: number;
  readonly expected: DrillCapture;
  /** "differs" · "identical" (a failure) · "skipped" when no live URL is available (in-place restore). */
  readonly divergence: "differs" | "identical" | "skipped";
  /** Whole seconds from the operator initiating the restore to this verdict. */
  readonly rtoSeconds: number;
}

const CAPTURE_FILE = (): string => process.env["DRILL_CAPTURE_FILE"] ?? "drill-capture.json";

export async function writeCapture(capture: DrillCapture): Promise<void> {
  await writeFile(CAPTURE_FILE(), `${JSON.stringify(capture, null, 2)}\n`, "utf8");
}

export async function readCapture(): Promise<DrillCapture> {
  return JSON.parse(await readFile(CAPTURE_FILE(), "utf8")) as DrillCapture;
}

/**
 * Everything here is read inside the caller's single transaction, and `now()` — which is transaction
 * start time, not clock time — is the recovery target. Under READ COMMITTED a concurrent commit can
 * still land between statements; that is why `postings` and `auditHeadSeq` are recorded. The verify
 * phase compares them, so a raced capture fails the drill loudly instead of passing quietly.
 */
export async function captureDrillPoint(
  tx: Sql,
  params: { tenantId: string; actorId: string; companyId: string; fiscalPeriodId: string },
): Promise<DrillCapture> {
  const [at] = await tx<{ at: string }[]>`select now()::text as at`;
  const fingerprint = await trialBalanceFingerprint(tx, {
    companyId: params.companyId,
    fiscalPeriodId: params.fiscalPeriodId,
  });
  const [counted] = await tx<{ postings: number }[]>`
    select count(*)::int as postings from app.ledger_entry`;
  const [head] = await tx<{ seq: number; hash: string }[]>`
    select seq::int as seq, encode(hash, 'hex') as hash
      from app.audit_log where tenant_id = ${params.tenantId} order by seq desc limit 1`;

  return {
    capturedAt: at!.at,
    tenantId: params.tenantId,
    actorId: params.actorId,
    companyId: params.companyId,
    fiscalPeriodId: params.fiscalPeriodId,
    fingerprint,
    postings: counted!.postings,
    auditHeadSeq: head?.seq ?? 0,
    auditHeadHash: head?.hash ?? "",
  };
}

export interface VerifyOptions {
  /** Carries the tenant, the actor and every figure to compare — the verify phase reads nothing else. */
  readonly capture: DrillCapture;
  /** The live fingerprint read just before the restore. Omitted for an in-place restore. */
  readonly liveFingerprintAtRestore?: string | undefined;
  /** ISO timestamp at which the operator initiated the restore, for the RTO measurement. */
  readonly restoreStartedAt: string;
}

/**
 * The whole of test 24, against the restored database and nothing else.
 *
 * "The trial balance computed from the restored ledger" is satisfied transitively and deliberately:
 * `trialBalanceFingerprint` reads `account_balance`, and `checkAccountBalanceProjection` rebuilds that
 * projection from `ledger_entry` in a scratch table and compares it row for row. Both green means the
 * figure equals one computed from the restored ledger. Reading the projection and re-deriving it in the
 * same breath is exactly the pairing spec:2265 asks for, and it is stronger than either alone: a restore
 * that dropped ledger rows but kept balances fails the second check.
 */
export async function verifyRestore(restored: Sql, opts: VerifyOptions): Promise<DrillVerdict> {
  const ctx: TenantContext = {
    tenantId: opts.capture.tenantId,
    actorId: opts.capture.actorId,
    requestId: await uuidv7(restored),
  };

  return withTenant(restored, ctx, async (tx) => {
    const fingerprint = await trialBalanceFingerprint(tx, {
      companyId: opts.capture.companyId,
      fiscalPeriodId: opts.capture.fiscalPeriodId,
    });
    const mismatches = await checkAccountBalanceProjection(tx);
    const chain = await checkAuditChain(tx, opts.capture.tenantId);
    const [counted] = await tx<{ postings: number }[]>`
      select count(*)::int as postings from app.ledger_entry`;
    const [head] = await tx<{ seq: number }[]>`
      select seq::int as seq from app.audit_log
       where tenant_id = ${opts.capture.tenantId} order by seq desc limit 1`;

    const divergence: DrillVerdict["divergence"] =
      opts.liveFingerprintAtRestore === undefined
        ? "skipped"
        : opts.liveFingerprintAtRestore === fingerprint
          ? "identical"
          : "differs";

    return {
      fingerprintMatches: fingerprint === opts.capture.fingerprint,
      projectionMismatches: mismatches.length,
      chain: {
        rows: chain.rows,
        brokenLinks: chain.brokenLinks,
        badHashes: chain.badHashes,
        headSeq: head?.seq ?? 0,
      },
      postings: counted!.postings,
      expected: opts.capture,
      divergence,
      rtoSeconds: Math.round((Date.now() - new Date(opts.restoreStartedAt).getTime()) / 1000),
    };
  });
}

const hhmmss = (seconds: number): string =>
  [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");

/** The five lines a drill prints, identical on staging and locally. The runbook records them verbatim. */
export function formatDrillVerdict(verdict: DrillVerdict): string {
  return [
    `trial-balance-fingerprint: ${verdict.fingerprintMatches ? "match" : "MISMATCH"}`,
    `projection-rebuild: ${
      verdict.projectionMismatches === 0 ? "clean" : `${verdict.projectionMismatches} MISMATCH(ES)`
    }`,
    `audit-chain: ${
      verdict.chain.brokenLinks === 0 && verdict.chain.badHashes === 0 ? "verified" : "BROKEN"
    } (${verdict.chain.rows} rows, ${verdict.chain.brokenLinks} broken links,` +
      ` ${verdict.chain.badHashes} bad hashes, head seq ${verdict.chain.headSeq}/${verdict.expected.auditHeadSeq})`,
    `divergence: ${
      verdict.divergence === "differs"
        ? "restored differs from live at restore time"
        : verdict.divergence === "identical"
          ? "IDENTICAL — the restore did not roll anything back"
          : "skipped (in-place restore: DRILL_LIVE_URL not set)"
    }`,
    `recovery: rpo ${verdict.postings === verdict.expected.postings ? "0 rows lost" : "ROWS LOST"}` +
      ` (postings ${verdict.postings}/${verdict.expected.postings})` +
      ` · rto ${hhmmss(verdict.rtoSeconds)} · target ${verdict.expected.capturedAt}`,
  ].join("\n");
}

const RESTORED_DB = "dulja_restored";
const DUMP_PATH = "/tmp/drill.dump";

/** Runs a command inside the Postgres container and throws with its whole output on failure. */
async function exec(db: Db, command: string): Promise<string> {
  const { exitCode, output } = await db.container.exec(["bash", "-c", command]);
  if (exitCode !== 0)
    throw new Error(`drill command failed (exit ${exitCode}): ${command}\n${output}`);
  return output;
}

/**
 * The local stand-in for "restore to a point in time". `pg_dump --format=custom` reads one REPEATABLE
 * READ snapshot, so the file is the database as of the moment it starts — which is the recovery target
 * the capture just recorded. It is NOT a WAL replay, and ADR 0025 says so; what it does prove is every
 * assertion in verifyRestore and every command in the runbook.
 *
 * Credentials come from the container object, never from a literal: PostgreSqlContainer generates them.
 */
export async function snapshotDatabase(db: Db): Promise<void> {
  const container = db.container;
  await exec(
    db,
    `PGPASSWORD='${container.getPassword()}' pg_dump -U '${container.getUsername()}' ` +
      `-d '${container.getDatabase()}' --format=custom --file='${DUMP_PATH}'`,
  );
}

/**
 * Restores that snapshot into a second database and returns the app_rw URL for it.
 *
 * `pg_restore` loads data in the pre-data → data → post-data order, and CREATE TRIGGER is post-data, so
 * the rows land before app.audit_chain() exists on the table. That is what makes the chain verifiable
 * after a restore: had the trigger been present the hashes would have been recomputed and the drill
 * would prove nothing. `--exit-on-error` makes a partial restore a failure instead of a warning.
 */
export async function restoreDatabase(db: Db): Promise<string> {
  const container = db.container;
  const env = `PGPASSWORD='${container.getPassword()}'`;
  await exec(db, `${env} dropdb -U '${container.getUsername()}' --if-exists '${RESTORED_DB}'`);
  await exec(db, `${env} createdb -U '${container.getUsername()}' '${RESTORED_DB}'`);
  await exec(
    db,
    `${env} pg_restore -U '${container.getUsername()}' -d '${RESTORED_DB}' ` +
      `--exit-on-error '${DUMP_PATH}'`,
  );
  // Db.url(role) is `postgres://role:pw@host:port/<database>`; only the database differs.
  return db.url("app_rw").replace(/\/[^/]+$/, `/${RESTORED_DB}`);
}
