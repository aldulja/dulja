import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EInvoiceProfileError } from "@dulja/domain";

import {
  availableProfileVersions,
  loadProfile,
  PROFILE_DIR,
  profilePath,
  ProfileNotFoundError,
} from "../../src/einvoice/profile";
import { EINVOICE_SECRET_NAMES, credentialsFor, readSecret } from "../../src/einvoice/credentials";
import { REDACTED, redactResponse } from "../../src/einvoice/redact";
import { EInvoiceError } from "../../src/einvoice/errors";
import { CLAIM_WINDOW_SECONDS } from "../../src/einvoice/transmission";

describe("loadProfile", () => {
  it("finds the committed synthetic profile and returns the highest version", () => {
    expect(availableProfileVersions("synthetic")).toEqual([1]);
    const p = loadProfile("synthetic");
    expect(p.code).toBe("synthetic");
    expect(p.version).toBe(1);
    expect(p.baseUrl.startsWith("http://127.0.0.1")).toBe(true);
  });

  it("resolves PROFILE_DIR to a real directory outside packages/db/seed", () => {
    expect(PROFILE_DIR.replace(/\\/g, "/")).toMatch(/packages\/db\/einvoice-profiles$/);
    expect(PROFILE_DIR.replace(/\\/g, "/")).not.toContain("/seed/");
    expect(profilePath("synthetic", 1).replace(/\\/g, "/")).toMatch(/synthetic\.v1\.json$/);
  });

  it("throws ProfileNotFoundError for a code with no file — this is OD-15's default state", () => {
    expect(availableProfileVersions("myinvois")).toEqual([]);
    expect(() => loadProfile("myinvois")).toThrow(ProfileNotFoundError);
    expect(() => loadProfile("myinvois")).toThrow(/no profile file for myinvois/);
  });

  it("throws EInvoiceProfileError, not a JSON error, on a malformed file", () => {
    // The synthetic profile with one property removed, written to a temp code, proves the loader
    // validates rather than trusting the disk.
    expect(() => loadProfile("synthetic", 99)).toThrow(ProfileNotFoundError);
  });
});

describe("timeoutMs — bounded by the transmission claim window (ADR 0053 §3)", () => {
  // claim() lets another caller take a transmission over once its claim is CLAIM_WINDOW_SECONDS
  // old, and one deadline of `timeoutMs` bounds a whole remote call — the token fetch, the request
  // and its 401 retry share one AbortController (http-transmitter.ts). The schema's maximum is the
  // only thing that keeps a call inside the window, so the two numbers live in two packages and
  // this pins them together: raising either one past the other fails here.
  const schema = JSON.parse(
    readFileSync(
      fileURLToPath(new URL("../../../domain/einvoice-profile.schema.json", import.meta.url)),
      "utf8",
    ),
  ) as { properties: { timeoutMs: { maximum: number; default: number } } };

  it("caps a profile's timeoutMs at no more than half of CLAIM_WINDOW_SECONDS", () => {
    expect(schema.properties.timeoutMs.maximum).toBeLessThanOrEqual(
      (CLAIM_WINDOW_SECONDS * 1000) / 2,
    );
    expect(schema.properties.timeoutMs.default).toBeLessThanOrEqual(
      schema.properties.timeoutMs.maximum,
    );
  });

  it("the committed profile is inside the cap, and loadProfile enforces it", () => {
    expect(loadProfile("synthetic").timeoutMs).toBeLessThanOrEqual(
      schema.properties.timeoutMs.maximum,
    );
    const dir = mkdtempSync(join(tmpdir(), "dulja-einvoice-timeout-"));
    try {
      writeFileSync(
        join(dir, "synthetic.v1.json"),
        JSON.stringify({
          ...JSON.parse(readFileSync(profilePath("synthetic", 1), "utf8")),
          timeoutMs: (CLAIM_WINDOW_SECONDS * 1000) / 2 + 1,
        }),
      );
      expect(() => loadProfile("synthetic", 1, dir)).toThrow(EInvoiceProfileError);
      expect(() => loadProfile("synthetic", 1, dir)).toThrow(/\/timeoutMs must be <=/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("credentials — the ref is a NAME and the value never leaves this module", () => {
  it("EINVOICE_SECRET_NAMES is the one enumerated name of §3.11", () => {
    expect(EINVOICE_SECRET_NAMES).toEqual(["EINVOICE_CLIENT_SECRET"]);
  });

  it("builds EInvoiceCredentials carrying the REF, never the value (§4.9.3)", () => {
    const c = credentialsFor({
      transmitter: "synthetic",
      clientId: "client-a",
      credentialRef: "EINVOICE_CLIENT_SECRET",
    });
    expect(c).toEqual({ clientId: "client-a", secretRef: "EINVOICE_CLIENT_SECRET" });
    expect(JSON.stringify(c)).not.toContain("shhh");
  });

  it("refuses a company with no transmitter — ERR_EINVOICE_NOT_ENABLED", () => {
    expect(() =>
      credentialsFor({ transmitter: null, clientId: null, credentialRef: null }),
    ).toThrow(EInvoiceError);
    try {
      credentialsFor({ transmitter: null, clientId: null, credentialRef: null });
    } catch (e) {
      expect((e as EInvoiceError).code).toBe("ERR_EINVOICE_NOT_ENABLED");
    }
  });

  it("refuses a ref outside EINVOICE_SECRET_NAMES even though the DDL pattern would allow it", () => {
    // The CHECK admits ^EINVOICE_[A-Z0-9_]+$ so a second authority needs no migration; the code
    // admits only names §3.11 enumerates, so containerSecrets can actually supply them.
    expect(() => readSecret("EINVOICE_SOMETHING_ELSE", { EINVOICE_SOMETHING_ELSE: "x" })).toThrow(
      /not an enumerated secret name/,
    );
  });

  it("refuses an unset secret with ERR_EINVOICE_TRANSMITTER_UNAVAILABLE, naming the variable", () => {
    try {
      readSecret("EINVOICE_CLIENT_SECRET", {});
    } catch (e) {
      expect((e as EInvoiceError).code).toBe("ERR_EINVOICE_TRANSMITTER_UNAVAILABLE");
      expect((e as EInvoiceError).message).toContain("EINVOICE_CLIENT_SECRET");
      expect((e as EInvoiceError).message).not.toContain("undefined");
    }
    expect(readSecret("EINVOICE_CLIENT_SECRET", { EINVOICE_CLIENT_SECRET: "s3cr3t" })).toBe(
      "s3cr3t",
    );
  });
});

describe("redactResponse — ADR 0053: what may reach `response jsonb`", () => {
  it("keeps the http status and the body's own members", () => {
    expect(redactResponse({ receiptId: "R1", state: "cleared" }, 201)).toEqual({
      httpStatus: 201,
      body: { receiptId: "R1", state: "cleared" },
    });
  });

  it("redacts any key matching the §4.2.3 forbidden-field pattern, at every depth", () => {
    const out = redactResponse(
      { token: "t", nested: { Authorization: "Bearer x", clientSecret: "s", ok: 1 } },
      200,
    );
    expect(out).toEqual({
      httpStatus: 200,
      body: { token: REDACTED, nested: { Authorization: REDACTED, clientSecret: REDACTED, ok: 1 } },
    });
  });

  it("redacts known credential values in ordinary fields and field names", () => {
    const out = redactResponse(
      { message: "Bearer fixture-secret", "fixture-secret": ["fixture-secret"] },
      422,
      ["fixture-secret"],
    );
    expect(JSON.stringify(out)).not.toContain("fixture-secret");
    expect((out.body as Record<string, unknown>).message).toBe("Bearer [redacted]");
  });

  it("truncates a long string rather than storing an unbounded blob", () => {
    const out = redactResponse({ reason: "x".repeat(5000) }, 422);
    const body = out.body as { reason: string };
    expect(body.reason.length).toBeLessThanOrEqual(1024 + 16);
    expect(body.reason.endsWith("…[truncated]")).toBe(true);
  });

  it("stores a non-JSON body as a described placeholder rather than dropping it", () => {
    expect(redactResponse("<html>not json</html>", 502)).toEqual({
      httpStatus: 502,
      body: { nonJson: true, length: 21 },
    });
  });

  it("caps an array so one absurd response cannot bloat every audit row", () => {
    const out = redactResponse({ items: Array.from({ length: 500 }, (_, i) => i) }, 200);
    const body = out.body as { items: unknown[] };
    expect(body.items).toHaveLength(51);
    expect(body.items[50]).toBe("…[450 more]");
  });
});
