import { MemoryObjectStore, R2ObjectStore } from "@dulja/db";
import { describe, expect, it } from "vitest";
import { objectStore, objectStoreFromEnv, R2_ENV_NAMES, setObjectStore } from "../src/object-store";

const R2 = {
  R2_ACCOUNT_ID: "acc",
  R2_ATTACHMENTS_BUCKET: "dulja-attachments",
  R2_ACCESS_KEY_ID: "AKIA",
  R2_SECRET_ACCESS_KEY: "r2-secret",
};

describe("the worker's object store (§3.11, §4.5.8)", () => {
  it("names the four §3.11 R2 variables", () => {
    expect([...R2_ENV_NAMES]).toEqual(Object.keys(R2));
  });

  it("is in-process in dev with none of the four set, and R2 with all four in any environment", () => {
    expect(objectStoreFromEnv({}, "dev")).toBeInstanceOf(MemoryObjectStore);
    expect(objectStoreFromEnv({ R2_ACCOUNT_ID: "" }, "dev")).toBeInstanceOf(MemoryObjectStore);
    for (const appEnv of ["dev", "staging", "production"] as const)
      expect(objectStoreFromEnv(R2, appEnv)).toBeInstanceOf(R2ObjectStore);
  });

  it("refuses some-but-not-all of the four, naming each missing variable", () => {
    const { R2_ACCESS_KEY_ID: _key, R2_SECRET_ACCESS_KEY: _secret, ...partial } = R2;
    expect(() => objectStoreFromEnv(partial, "dev")).toThrowError(
      /missing: R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY$/,
    );
  });

  it("refuses none of the four outside dev, because a rendered report would have nowhere to go", () => {
    for (const appEnv of ["staging", "production"] as const)
      expect(() => objectStoreFromEnv({}, appEnv)).toThrowError(
        new RegExp(`APP_ENV=${appEnv} .*missing: ${R2_ENV_NAMES.join(", ")}`),
      );
  });

  it("refuses a read before boot has set the store, and returns the one set after", () => {
    expect(() => objectStore()).toThrowError(/called before setObjectStore/);
    const store = new MemoryObjectStore();
    setObjectStore(store);
    expect(objectStore()).toBe(store);
  });
});
