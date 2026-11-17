import { ERRORS } from "@dulja/contracts";
import { fullRegression, problemOf } from "../support/api";

fullRegression(
  "LEGACY-084",
  "Error messages are not actionable and the code convention is broken",
  {
    "every registry entry has a title and a remedy, and every code follows ERR_<DOMAIN>_<REASON>":
      async ({ expect }) => {
        for (const [code, def] of Object.entries(ERRORS)) {
          expect(code === "ERR_INTERNAL" || /^ERR_[A-Z]+(?:_[A-Z0-9]+)+$/.test(code)).toBe(true);
          expect(def.title.length, code).toBeGreaterThan(0);
          expect(def.remedy.length, code).toBeGreaterThan(0);
          expect(def.remedy, code).not.toMatch(/^(error|failed|invalid)\.?$/i);
        }
      },

    "a real validation failure names the field and says what to do about it": async ({
      api,
      a,
      expect,
    }) => {
      const res = await api.request({
        method: "POST",
        path: "/v1/companies",
        as: a.human,
        body: { code: "not lower case!", name: "", baseCurrency: "RINGGIT" },
      });
      expect(res.status).toBe(400);
      const problem = await problemOf(res);
      expect(problem.code).toBe("ERR_VALIDATION_FAILED");
      expect(problem.title).toBe(ERRORS.ERR_VALIDATION_FAILED.title);
      expect(problem.remedy).toBe(ERRORS.ERR_VALIDATION_FAILED.remedy);
      expect(problem.instance).toContain("/v1/companies");
      const paths = (problem.errors ?? []).map((e) => e.path);
      for (const field of ["code", "name", "baseCurrency"])
        expect(paths.join(" ")).toContain(field);
    },

    "the response is a problem document, so a client can branch on `code` without parsing prose":
      async ({ api, expect }) => {
        const res = await api.request({ method: "GET", path: "/v1/session" });
        expect(res.headers.get("content-type")).toMatch(/application\/problem\+json/);
        const problem = await problemOf(res);
        for (const key of [
          "type",
          "title",
          "status",
          "detail",
          "instance",
          "code",
          "remedy",
          "requestId",
        ]) {
          expect(Object.keys(problem)).toContain(key);
        }
      },
  },
);
