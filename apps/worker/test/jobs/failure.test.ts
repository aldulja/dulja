// Phase 7 review, finding 6: `reporting.render` and `admin.export.run` share ONE failure-detail helper, and a
// stored reason is capped the same way on both paths. No container: the helper is pure.
import { describe, expect, it } from "vitest";
import { FAILURE_DETAIL_MAX as STORE_CAP } from "@dulja/db";
import { FAILURE_DETAIL_MAX, failureDetail } from "../../src/jobs/failure";

class Coded extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

describe("failureDetail — the `CODE: detail` a failed run or export shows (7 review)", () => {
  it("keeps a stable ERR_* code and maps anything else to ERR_INTERNAL", () => {
    expect(failureDetail(new Coded("ERR_VALIDATION_FAILED", "narrow it"))).toBe(
      "ERR_VALIDATION_FAILED: narrow it",
    );
    expect(failureDetail(new Coded("ECONNRESET", "socket"))).toBe("ERR_INTERNAL: socket");
    expect(failureDetail(new Error("boom"))).toBe("ERR_INTERNAL: boom");
    expect(failureDetail("plain")).toBe("ERR_INTERNAL: plain");
  });

  it("caps the detail at FAILURE_DETAIL_MAX characters, keeping the code", () => {
    const detail = failureDetail(new Coded("ERR_VALIDATION_FAILED", "x".repeat(10_000)));
    expect(FAILURE_DETAIL_MAX).toBe(2000);
    expect(detail.length).toBe(FAILURE_DETAIL_MAX);
    expect(detail.startsWith("ERR_VALIDATION_FAILED: ")).toBe(true);
  });

  it("caps at the stores' own figure — one constant, owned by @dulja/db (7 second review, finding 7)", () => {
    expect(FAILURE_DETAIL_MAX).toBe(STORE_CAP);
  });
});
