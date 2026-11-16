import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { EInvoiceError } from "../../src/einvoice/errors";
import { PROFILE_DIR } from "../../src/einvoice/profile";
import {
  registerDefaultTransmitters,
  registeredTransmitters,
  resetTransmitters,
  transmitterFor,
} from "../../src/einvoice/registry";

// Both entrypoints call registerDefaultTransmitters at module top level, so a throw from it is a
// container that crash-loops, not a refused request — which is what the staging image did when it
// shipped without packages/db/einvoice-profiles. Each case points it at a profile directory that is
// missing or holds a bad file, never at the committed one, and requires the fail-closed outcome
// profile.ts promises: nothing registered, the skip reported for the entrypoint to log, and
// ERR_EINVOICE_TRANSMITTER_UNAVAILABLE from the registry's door.

const root = mkdtempSync(join(tmpdir(), "dulja-einvoice-profiles-"));
const absent = join(root, "absent");
const committed = JSON.parse(
  readFileSync(join(PROFILE_DIR, "synthetic.v1.json"), "utf8"),
) as Record<string, unknown>;

function profileDir(name: string, contents: string): string {
  const dir = join(root, name);
  mkdirSync(dir);
  writeFileSync(join(dir, "synthetic.v1.json"), contents);
  return dir;
}

function expectUnavailable(code: string): void {
  let refusal: unknown;
  try {
    transmitterFor(code);
  } catch (error) {
    refusal = error;
  }
  expect(refusal, `transmitterFor(${code}) returned a transmitter`).toBeInstanceOf(EInvoiceError);
  expect((refusal as EInvoiceError).code).toBe("ERR_EINVOICE_TRANSMITTER_UNAVAILABLE");
  expect((refusal as EInvoiceError).message).toContain("(registered: none)");
}

function refusalOf(lookup: () => unknown): EInvoiceError {
  let refusal: unknown;
  try {
    lookup();
  } catch (error) {
    refusal = error;
  }
  expect(refusal, "the lookup returned a transmitter").toBeInstanceOf(EInvoiceError);
  expect((refusal as EInvoiceError).code).toBe("ERR_EINVOICE_TRANSMITTER_UNAVAILABLE");
  return refusal as EInvoiceError;
}

beforeEach(() => resetTransmitters());
afterAll(() => {
  resetTransmitters();
  rmSync(root, { recursive: true, force: true });
});

describe("registerDefaultTransmitters — fail closed, never crash boot", () => {
  it("registers synthetic from the committed profile in dev and staging, and reports no skip", () => {
    for (const appEnv of ["dev", "staging"] as const) {
      resetTransmitters();
      expect(registerDefaultTransmitters(appEnv)).toEqual({
        registered: ["synthetic"],
        skipped: [],
      });
      expect(registeredTransmitters()).toEqual(["synthetic"]);
    }
  });

  it("registers nothing in production and reports no skip: that is ADR 0052's policy, not a fault", () => {
    expect(registerDefaultTransmitters("production", { profileDir: absent })).toEqual({
      registered: [],
      skipped: [],
    });
    expectUnavailable("synthetic");
  });

  it("skips synthetic when the profile directory is missing, as it was in the staging image", () => {
    const report = registerDefaultTransmitters("staging", { profileDir: absent });
    expect(report.registered).toEqual([]);
    expect(report.skipped).toEqual([{ code: "synthetic", reason: expect.any(String) }]);
    expect(report.skipped[0]!.reason).toMatch(
      /^ProfileNotFoundError: no profile file for synthetic/,
    );
    expect(report.skipped[0]!.reason).toContain(absent);
    expectUnavailable("synthetic");
  });

  it.each([
    ["is not JSON", "{ not json", /^ProfileNotFoundError: .*is not JSON/],
    [
      "fails the profile schema",
      JSON.stringify({ ...committed, calls: undefined }),
      /^EInvoiceProfileError: e-invoice profile is invalid/,
    ],
    [
      "names another version than its file",
      JSON.stringify({ ...committed, version: 2 }),
      /^ProfileNotFoundError: .*declares synthetic\.v2/,
    ],
  ])("skips synthetic when its profile %s", (name, contents, reason) => {
    const report = registerDefaultTransmitters("dev", {
      profileDir: profileDir(name.replace(/\W+/g, "-"), contents),
    });
    expect(report.registered).toEqual([]);
    expect(report.skipped).toHaveLength(1);
    expect(report.skipped[0]!.code).toBe("synthetic");
    expect(report.skipped[0]!.reason).toMatch(reason);
    expectUnavailable("synthetic");
  });

  it("leaves a skipped code unavailable even when an earlier call had registered it", () => {
    registerDefaultTransmitters("dev");
    expect(registeredTransmitters()).toEqual(["synthetic"]);
    expect(registerDefaultTransmitters("staging", { profileDir: absent }).skipped).toHaveLength(1);
    expectUnavailable("synthetic");
  });
});

// ADR 0053, "Also open": one transmitter per code, built from the highest file, stranded every row
// recorded under an older version the day `<code>.v2.json` shipped — poll and cancel refused it. The
// registry now holds every version it can build, and a caller names the one a row is pinned to.
describe("registerDefaultTransmitters — every profile version, resolved by the row's pin", () => {
  function versionsDir(name: string, files: Record<number, string>): string {
    const dir = join(root, name);
    mkdirSync(dir);
    for (const [version, contents] of Object.entries(files))
      writeFileSync(join(dir, `synthetic.v${version}.json`), contents);
    return dir;
  }
  const v = (version: number) => JSON.stringify({ ...committed, version });

  it("registers v1 and v2 alike: the highest unless a version is named, the named one when it is", () => {
    const dir = versionsDir("v1-and-v2", { 1: v(1), 2: v(2) });
    expect(registerDefaultTransmitters("dev", { profileDir: dir })).toEqual({
      registered: ["synthetic"],
      skipped: [],
    });
    expect(transmitterFor("synthetic").profile.version).toBe(2); // a new submission
    expect(transmitterFor("synthetic", 2).profile.version).toBe(2);
    expect(transmitterFor("synthetic", 1).profile.version).toBe(1); // a row pinned to v1
  });

  it("refuses a pinned version that is not registered, naming it and what is", () => {
    registerDefaultTransmitters("dev", { profileDir: versionsDir("v2-only", { 2: v(2) }) });
    expect(transmitterFor("synthetic").profile.version).toBe(2);
    const refusal = refusalOf(() => transmitterFor("synthetic", 1));
    expect(refusal.detail).toContain("synthetic profile version 1 is not registered");
    expect(refusal.detail).toContain("registered versions of synthetic: 2");
  });

  it("names the pinned version when no version of the code is registered at all", () => {
    // Every file of the code failed to build (or none shipped): a row pinned to v1 is refused like
    // any missing pin, and the refusal says which version the row needed, not only the code.
    expect(registerDefaultTransmitters("dev", { profileDir: absent }).registered).toEqual([]);
    const refusal = refusalOf(() => transmitterFor("synthetic", 1));
    expect(refusal.detail).toContain("synthetic profile version 1 is not registered");
    expect(refusal.detail).toContain("registered versions of synthetic: none");
    // A new submission, which names no version, keeps the code-level refusal.
    expectUnavailable("synthetic");
  });

  it("skips a bad version alone, and fails closed for a new submission when that is the highest", () => {
    const report = registerDefaultTransmitters("dev", {
      profileDir: versionsDir("v2-bad", { 1: v(1), 2: "{ not json" }),
    });
    expect(report.registered).toEqual(["synthetic"]);
    expect(report.skipped).toEqual([{ code: "synthetic", version: 2, reason: expect.any(String) }]);
    expect(report.skipped[0]!.reason).toMatch(/^ProfileNotFoundError: .*is not JSON/);
    // A row pinned to v1 is still served by v1…
    expect(transmitterFor("synthetic", 1).profile.version).toBe(1);
    // …but a submission is not quietly sent under v1 when the deployment shipped v2 and v2 is
    // broken: that is the fail-closed direction ADR 0052 takes for a profile that does not parse.
    expect(refusalOf(() => transmitterFor("synthetic")).detail).toContain(
      "synthetic profile version 2 is not registered",
    );
  });

  it("does not keep a version a later registration no longer finds", () => {
    registerDefaultTransmitters("dev", {
      profileDir: versionsDir("before", { 1: v(1), 2: v(2) }),
    });
    registerDefaultTransmitters("dev", { profileDir: versionsDir("after", { 1: v(1) }) });
    expect(transmitterFor("synthetic").profile.version).toBe(1);
    expect(refusalOf(() => transmitterFor("synthetic", 2)).detail).toContain(
      "synthetic profile version 2 is not registered",
    );
  });
});
