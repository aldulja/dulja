import { describe, expect, it } from "vitest";
import { createDb, PoolerUrlError } from "../src/client";

describe("createDb — session mode only", () => {
  it("refuses a transaction-mode pooler URL without exposing its password", () => {
    const url = "postgres://app_rw:hunter2@pooler.example:6543/postgres";
    expect(() => createDb(url)).toThrow(PoolerUrlError);
    try {
      createDb(url);
    } catch (error) {
      const err = error as PoolerUrlError;
      expect(err.code).toBe("ERR_DB_POOLER_URL");
      expect(err.message).toContain("ERR_DB_POOLER_URL");
      expect(err.message).toContain("6543");
      expect(err.message).not.toContain("hunter2");
    }
  });
  it("uses a four-connection pool by default and honours an override", () => {
    expect(createDb("postgres://app_rw:pw@127.0.0.1:5432/postgres").options.max).toBe(4);
    expect(createDb("postgres://app_rw:pw@127.0.0.1:5432/postgres", { max: 1 }).options.max).toBe(
      1,
    );
  });
});
