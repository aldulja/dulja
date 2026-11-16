import { LoadError } from "./types";

/**
 * The tenant and company a run loads INTO. `runLoad` hands it to the source factory (`LoadSourceFactory`), so the
 * production factory can refuse to open a source that is not this company's.
 */
export interface ImportTarget {
  readonly tenantId: string;
  readonly companyId: string;
}

/** The variable that binds the deployment's ONE configured legacy source (`LEGACY_ODBC_DSN`) to one tenant and
 *  company (9B review, finding 1; contracts §3.11, round 20 C19). Written `<tenantId>:<companyId>`. */
export const IMPORT_TARGET_ENV = "LEGACY_IMPORT_TARGET";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const BINDING = new RegExp(`^(${UUID}):(${UUID})$`, "i");

/**
 * The binding as configured, or the refusal. Its value is never echoed: a run of another tenant must not learn
 * which tenant and company the source belongs to.
 */
export function importTargetFromEnv(env: NodeJS.ProcessEnv = process.env): ImportTarget {
  const raw = env[IMPORT_TARGET_ENV]?.trim();
  if (!raw)
    throw new LoadError(
      "ERR_IMPORT_SOURCE_NOT_BOUND",
      `${IMPORT_TARGET_ENV} is not set; the configured legacy source is bound to no company, so no run may read it — bind it to the cut-over's <tenantId>:<companyId> beside LEGACY_ODBC_DSN (contracts §3.11, round 20 C19)`,
    );
  const match = BINDING.exec(raw);
  if (!match)
    throw new LoadError(
      "ERR_IMPORT_SOURCE_NOT_BOUND",
      `${IMPORT_TARGET_ENV} is not <tenantId>:<companyId> (two uuids); no run may read the configured legacy source until it is (contracts §3.11, round 20 C19)`,
    );
  return { tenantId: match[1]!.toLowerCase(), companyId: match[2]!.toLowerCase() };
}

/**
 * Refuses a run of any tenant or company but the one the configured source is bound to — BEFORE the source is opened,
 * so nothing of it is read. The worker calls it for every run and `loadSourceFromEnv` again before it connects; the
 * CLI calls it whenever the DSN comes from the environment rather than from an explicit `--dsn`.
 */
export function assertImportTarget(
  target: ImportTarget,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const bound = importTargetFromEnv(env);
  if (
    bound.tenantId !== target.tenantId.toLowerCase() ||
    bound.companyId !== target.companyId.toLowerCase()
  )
    throw new LoadError(
      "ERR_IMPORT_SOURCE_NOT_BOUND",
      `the configured legacy source is bound to another tenant or company by ${IMPORT_TARGET_ENV}; company ${target.companyId} of tenant ${target.tenantId} may not read it, and nothing was read (contracts §3.11, round 20 C19)`,
    );
}
