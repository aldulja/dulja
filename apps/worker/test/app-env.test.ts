import { describe, expect, it } from "vitest";
import { AppEnvError, parseAppEnv } from "../src/app-env";

// apps/worker/src/index.ts reads APP_ENV before it registers a handler or a transmitter, and the
// value decides whether the synthetic transmitter — which manufactures acceptances — is reachable
// (ADR 0052 decision 6). The worker used to compare it exactly and fall back to "dev", so an unset
// variable and a misspelt one ("prod", "Production", "staging ") alike registered it. The API refuses
// an unknown value (apps/api/src/config.ts); the worker now reads it the same way.

describe("parseAppEnv — the worker reads APP_ENV as the API does", () => {
  it("is dev when APP_ENV is unset", () => {
    expect(parseAppEnv({})).toBe("dev");
  });

  it.each(["dev", "staging", "production"] as const)("accepts %s as given", (appEnv) => {
    expect(parseAppEnv({ APP_ENV: appEnv })).toBe(appEnv);
  });

  it.each(["prod", "Production", "staging ", "live", ""])(
    "refuses %j instead of falling back to dev",
    (appEnv) => {
      expect(() => parseAppEnv({ APP_ENV: appEnv })).toThrow(AppEnvError);
      expect(() => parseAppEnv({ APP_ENV: appEnv })).toThrow(
        `invalid APP_ENV ${JSON.stringify(appEnv)} — expected dev, staging or production`,
      );
    },
  );
});
