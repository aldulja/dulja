import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadSourceFromEnv } from "../../src/load/run";
import { assertImportTarget, IMPORT_TARGET_ENV, importTargetFromEnv } from "../../src/load/target";

/**
 * 9B review, finding 1 — the deployment's ONE configured legacy source (`LEGACY_ODBC_DSN`, process-wide in a worker
 * that serves every tenant) is bound to exactly one tenant and company by `LEGACY_IMPORT_TARGET` (contracts §3.11,
 * round 20 C19). Without it, any holder of the import gate in ANY company could load that database — employees'
 * sensitive fields included — into their own. Every refusal comes before a connection is attempted, and none echoes
 * the binding: a run of another tenant must not learn whose source it is.
 */
const TENANT = randomUUID();
const COMPANY = randomUUID();
const NAMES = ["LEGACY_ODBC_DSN", IMPORT_TARGET_ENV] as const;
const saved: Partial<Record<(typeof NAMES)[number], string>> = {};

beforeEach(() => {
  for (const name of NAMES) {
    const value = process.env[name];
    if (value !== undefined) saved[name] = value;
    delete process.env[name];
  }
  // A DSN no driver can open: reaching the connection would answer ERR_IMPORT_SOURCE_UNREADABLE, so a refusal that
  // answers ERR_IMPORT_SOURCE_NOT_BOUND came before it.
  process.env["LEGACY_ODBC_DSN"] = "DSN=dulja-test-no-such-source;UID=reader;PWD=s3cret-value";
});
afterEach(() => {
  for (const name of NAMES) {
    delete process.env[name];
    const value = saved[name];
    if (value !== undefined) process.env[name] = value;
  }
});

describe("LEGACY_IMPORT_TARGET binds the configured legacy source to one tenant and company", () => {
  it("refuses every run while the binding is unset, before the source is opened", async () => {
    await expect(loadSourceFromEnv({ tenantId: TENANT, companyId: COMPANY })).rejects.toThrow(
      /^ERR_IMPORT_SOURCE_NOT_BOUND: LEGACY_IMPORT_TARGET is not set;/,
    );
  });

  it("refuses another company of the bound tenant, and another tenant, without naming the binding", async () => {
    process.env[IMPORT_TARGET_ENV] = `${TENANT}:${COMPANY}`;
    const otherCompany = randomUUID();
    const otherTenant = randomUUID();
    for (const target of [
      { tenantId: TENANT, companyId: otherCompany },
      { tenantId: otherTenant, companyId: COMPANY },
    ]) {
      const refusal = loadSourceFromEnv(target);
      await expect(refusal).rejects.toThrow(
        /^ERR_IMPORT_SOURCE_NOT_BOUND: the configured legacy source is bound to another tenant or company/,
      );
      const message = await refusal.catch((e: Error) => e.message);
      expect(message).not.toContain(target.tenantId === TENANT ? COMPANY : TENANT);
      expect(message).not.toMatch(/PWD|s3cret/);
    }
  });

  it("refuses a binding that is not two uuids, without echoing it", () => {
    for (const value of [TENANT, `${TENANT}:`, `${TENANT}:${COMPANY}:x`, "tenant:company"]) {
      process.env[IMPORT_TARGET_ENV] = value;
      expect(() => assertImportTarget({ tenantId: TENANT, companyId: COMPANY })).toThrow(
        /^ERR_IMPORT_SOURCE_NOT_BOUND: LEGACY_IMPORT_TARGET is not <tenantId>:<companyId> \(two uuids\);/,
      );
    }
  });

  it("opens the source for the bound company alone — the connection is then what answers", async () => {
    process.env[IMPORT_TARGET_ENV] = ` ${TENANT.toUpperCase()}:${COMPANY} `;
    expect(importTargetFromEnv()).toEqual({ tenantId: TENANT, companyId: COMPANY });
    // With no native `odbc` binding the import is refused; with one, the DSN names no data source. Either way the
    // binding let the run through to the connection, and the DSN's password is not in the refusal.
    const reached = await loadSourceFromEnv({ tenantId: TENANT, companyId: COMPANY }).catch(
      (e: Error) => e.message,
    );
    expect(reached).toMatch(/^ERR_IMPORT_SOURCE_UNREADABLE/);
    expect(reached).not.toMatch(/s3cret/);
  });
});
