import {
  rotateSensitiveBatch,
  withTenant,
  type RotationBatch,
  type RotationResult,
} from "@dulja/db";
import { registerHandler, registeredJobNames, type JobHandler } from "../handler";
import { hrKeyRing } from "../hr-keys";
import { log } from "../log";

/** Rows per transaction when the payload names none. */
export const HR_KEY_ROTATE_DEFAULT_BATCH = 200;
/** The largest batch a payload may ask for: one batch is one transaction holding row locks on that many rows. */
export const HR_KEY_ROTATE_MAX_BATCH = 5_000;
/** A bound on the walk, not a business limit: 10 000 batches is two million rows at the default size. */
const MAX_BATCHES = 10_000;

/**
 * `hr.encryption_key.rotate` (§4.2.6, `schedule: null`, owner 8D; spec:2273, ADR 0080): re-seal every
 * `employee_sensitive` row of the envelope's tenant whose `key_version` is below the ring's current version, under
 * the current key, in keyset batches of `batchSize` rows — **many short transactions, never one long one**
 * (spec:1368). A crash halfway leaves every completed batch committed, and the `key_version < current` predicate makes
 * a re-run a no-op over them.
 *
 * Runs as the tenant's SYSTEM principal (hazard 20): `runJob` hands it `systemContext`, `sensitive_gate`'s
 * `app.actor_has` admits the system principal, and every update is stamped and audited under it. The ring is the one
 * `apps/worker/src/index.ts` composed at boot (`hrKeyRing()`), never assembled from the environment here.
 *
 * No key material and no employee identifier reaches the log — one completion line with the counts.
 */
export const hrKeyRotateHandler: JobHandler<"hr.encryption_key.rotate"> = async (sql, job, ctx) => {
  const ring = hrKeyRing();
  const batchSize = job.payload.batchSize ?? HR_KEY_ROTATE_DEFAULT_BATCH;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > HR_KEY_ROTATE_MAX_BATCH)
    throw new RangeError(
      `hr.encryption_key.rotate: batchSize must be an integer between 1 and ${HR_KEY_ROTATE_MAX_BATCH}; received ${batchSize}`,
    );
  const companyId = job.payload.companyId ?? null;
  const result: RotationResult = { batches: 0, scanned: 0, rotated: 0 };
  let cursor: string | null = null;
  let complete = false;
  for (let i = 0; i < MAX_BATCHES; i += 1) {
    const after: string | null = cursor;
    const batch: RotationBatch = await withTenant(sql, ctx, (tx) =>
      rotateSensitiveBatch(tx, ring, { batchSize, afterEmployeeId: after, companyId }),
    );
    result.batches += 1;
    result.scanned += batch.scanned;
    result.rotated += batch.rotated;
    if (batch.lastEmployeeId === null) {
      complete = true;
      break;
    }
    cursor = batch.lastEmployeeId;
  }
  // An incomplete walk is not a failure — every batch it ran is committed and a re-run continues from what is left —
  // but the operator must not retire HR_FIELD_ENCRYPTION_KEY_PREVIOUS on it (docs/runbooks/hr-key-rotation.md).
  const fields = {
    tenant_id: ctx.tenantId,
    request_id: ctx.requestId,
    company_id: companyId,
    batches: result.batches,
    scanned: result.scanned,
    rotated: result.rotated,
    key_version: ring.current().version,
    complete,
  };
  if (complete) log().info(fields, "hr_key_rotation_complete");
  else log().warn(fields, "hr_key_rotation_incomplete");
};

/** Idempotent: `registerHandler` throws on a second registration, and a test that starts a worker (which registers
 *  every shipped handler) may call this again. */
export function registerHrKeyRotate(): void {
  if (registeredJobNames().includes("hr.encryption_key.rotate")) return;
  registerHandler("hr.encryption_key.rotate", hrKeyRotateHandler);
}
