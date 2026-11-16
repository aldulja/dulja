import type { Sql } from "postgres";
import {
  systemContext,
  type JobEnvelope,
  type JobName,
  type JobPayload,
  type TenantContext,
} from "@dulja/db";

export type JobHandler<N extends JobName> = (
  sql: Sql,
  job: JobEnvelope<JobPayload[N]>,
  ctx: TenantContext,
) => Promise<void>;
const HANDLERS = new Map<JobName, JobHandler<JobName>>();
export function registerHandler<N extends JobName>(name: N, handler: JobHandler<N>): void {
  if (HANDLERS.has(name)) throw new Error(`a handler for ${name} is already registered`);
  HANDLERS.set(name, handler as unknown as JobHandler<JobName>);
}
export function registeredJobNames(): JobName[] {
  return [...HANDLERS.keys()].toSorted();
}
export async function runJob<N extends JobName>(
  sql: Sql,
  name: N,
  job: JobEnvelope<JobPayload[N]>,
): Promise<void> {
  const handler = HANDLERS.get(name);
  if (!handler) throw new Error(`no handler registered for job ${name}`);
  const ctx = await systemContext(sql, job.tenantId, job.requestId);
  await (handler as unknown as JobHandler<N>)(sql, job, ctx);
}
export function resetHandlers(): void {
  HANDLERS.clear();
}
