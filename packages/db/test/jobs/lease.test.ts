// Phase 7 second review, finding 7 — the report run's and the tenant export's lease were two copies of one
// machine (the claim's CASE ladder, the fence, the abandoned message, the job options, the 2,000-character
// cap). They are one helper now, `src/jobs/lease.ts`, and both stores are parameterisations of it. No container.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  EXPORT_JOB_JOB_OPTIONS,
  EXPORT_JOB_LEASE_SECONDS,
  EXPORT_JOB_MAX_CLAIMS,
  FAILURE_DETAIL_MAX,
  REPORT_RUN_JOB_OPTIONS,
  REPORT_RUN_LEASE_SECONDS,
  REPORT_RUN_MAX_CLAIMS,
  LEASE_FOLLOW_UP_MARGIN_SECONDS,
  exportJobFollowUpOptions,
  leaseJobOptions,
  reportRunFollowUpOptions,
} from "../../src";

const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

describe("the leased-row machinery is one helper (7 second review, finding 7)", () => {
  it("the failure cap is one constant, owned by packages/db", () => {
    expect(FAILURE_DETAIL_MAX).toBe(2000);
    for (const store of ["../../src/reports/run-store.ts", "../../src/export/store.ts"]) {
      const text = source(store);
      expect(text, store).not.toMatch(/slice\(0,\s*2000\)/);
      expect(text, store).toContain("FAILURE_DETAIL_MAX");
    }
  });

  it("neither store carries its own claim ladder, fence or lease interval", () => {
    for (const store of ["../../src/reports/run-store.ts", "../../src/export/store.ts"]) {
      const text = source(store);
      expect(text, store).not.toContain("make_interval");
      expect(text, store).not.toMatch(/then 'failed' else 'running'/);
      expect(text, store).not.toMatch(/function fence\(/);
      expect(text, store).toContain("claimLeased");
      expect(text, store).toContain("leaseFence");
    }
    expect(source("../../src/jobs/lease.ts")).toContain("make_interval(secs =>");
  });

  it("both job option sets are the one rule over their own lease", () => {
    expect(REPORT_RUN_JOB_OPTIONS).toEqual(
      leaseJobOptions({
        table: () => undefined as never,
        leaseSeconds: REPORT_RUN_LEASE_SECONDS,
        maxClaims: REPORT_RUN_MAX_CLAIMS,
        abandoned: "",
      }),
    );
    expect(EXPORT_JOB_JOB_OPTIONS).toEqual(
      leaseJobOptions({
        table: () => undefined as never,
        leaseSeconds: EXPORT_JOB_LEASE_SECONDS,
        maxClaims: EXPORT_JOB_MAX_CLAIMS,
        abandoned: "",
      }),
    );
  });

  it("a live claim's follow-up is due after its lease, keyed to that claim, with a full retry budget (second review, finding 1)", () => {
    const state = { status: "running", attempts: 2, remainingSeconds: 540 };
    expect(reportRunFollowUpOptions("r-1", state)).toEqual({
      ...REPORT_RUN_JOB_OPTIONS,
      singletonKey: "r-1:lease:2",
      startAfterSeconds: 540 + LEASE_FOLLOW_UP_MARGIN_SECONDS,
    });
    expect(exportJobFollowUpOptions("e-1", { ...state, attempts: 3 })).toEqual({
      ...EXPORT_JOB_JOB_OPTIONS,
      singletonKey: "e-1:lease:3",
      startAfterSeconds: 540 + LEASE_FOLLOW_UP_MARGIN_SECONDS,
    });
  });
});
