import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ConfigError, DEV_HR_KEY, HR_KEY_BYTES } from "@dulja/db";
import { hrKeyRing, hrKeyRingFromEnv, parseHrKeyVersion, setHrKeyRing } from "../src/hr-keys";

// 8D A1/A12 — the worker reads §3.11's three HR names on the API's terms (apps/api/src/config.ts), because §3.1 forbids
// it importing the API's reader.
const KEY = randomBytes(HR_KEY_BYTES).toString("base64");
const OLD = randomBytes(HR_KEY_BYTES).toString("base64");

describe("the worker's HR key ring (8D A12, ADR 0080)", () => {
  it("refuses a read before boot has set the ring, and returns the one set after", () => {
    expect(() => hrKeyRing()).toThrow(ConfigError);
    expect(() => hrKeyRing()).toThrow(/called before setHrKeyRing/);
    const ring = hrKeyRingFromEnv({ HR_FIELD_ENCRYPTION_KEY: KEY }, "production");
    setHrKeyRing(ring);
    expect(hrKeyRing()).toBe(ring);
  });

  it("uses the all-zero dev key only in dev, and requires the key everywhere else", () => {
    expect(
      hrKeyRingFromEnv({}, "dev").current().bytes.equals(Buffer.from(DEV_HR_KEY, "base64")),
    ).toBe(true);
    for (const appEnv of ["staging", "production"] as const)
      expect(() => hrKeyRingFromEnv({}, appEnv)).toThrow(
        new RegExp(`^HR_FIELD_ENCRYPTION_KEY is required when APP_ENV=${appEnv}`),
      );
    // Read from APP_ENV when no appEnv is passed — unset is dev, as parseAppEnv reads it.
    expect(() => hrKeyRingFromEnv({ APP_ENV: "production" })).toThrow(ConfigError);
    expect(hrKeyRingFromEnv({}).current().version).toBe(1);
  });

  it("defaults the version to 1 and pairs a rotated version with the previous key at version − 1", () => {
    expect(hrKeyRingFromEnv({ HR_FIELD_ENCRYPTION_KEY: KEY }, "production").current().version).toBe(
      1,
    );
    const ring = hrKeyRingFromEnv(
      {
        HR_FIELD_ENCRYPTION_KEY: KEY,
        HR_FIELD_ENCRYPTION_KEY_PREVIOUS: OLD,
        HR_FIELD_ENCRYPTION_KEY_VERSION: "2",
      },
      "production",
    );
    expect(ring.current().version).toBe(2);
    expect(ring.forVersion(1).bytes.equals(Buffer.from(OLD, "base64"))).toBe(true);
  });

  it("refuses a previous key beside version 1, and a version outside 1–255, naming the variable", () => {
    expect(() =>
      hrKeyRingFromEnv(
        { HR_FIELD_ENCRYPTION_KEY: KEY, HR_FIELD_ENCRYPTION_KEY_PREVIOUS: OLD },
        "production",
      ),
    ).toThrow(
      /^HR_FIELD_ENCRYPTION_KEY_PREVIOUS is bound but HR_FIELD_ENCRYPTION_KEY_VERSION is 1/,
    );
    for (const bad of ["0", "-1", "1.5", "1e0", " 2", "256", "two", "01"])
      expect(() => parseHrKeyVersion(bad), bad).toThrow(
        /^HR_FIELD_ENCRYPTION_KEY_VERSION must be an integer between 1 and 255/,
      );
    expect(parseHrKeyVersion(undefined)).toBe(1);
    expect(parseHrKeyVersion("")).toBe(1);
    expect(parseHrKeyVersion("255")).toBe(255);
  });

  it("refuses a key that is not base64 of exactly 32 bytes, naming the variable", () => {
    expect(() =>
      hrKeyRingFromEnv(
        { HR_FIELD_ENCRYPTION_KEY: Buffer.alloc(16).toString("base64") },
        "production",
      ),
    ).toThrow(/^HR_FIELD_ENCRYPTION_KEY decodes to 16 bytes; exactly 32/);
  });
});
