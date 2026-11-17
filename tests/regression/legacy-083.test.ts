import { AppError, ERRORS, type ErrCode, type Problem } from "@dulja/contracts";
import { Hono } from "hono";
import type { AppEnv } from "../../apps/api/src/context";
import { toProblemResponse } from "../../apps/api/src/problem";
import { fullRegression, problemOf } from "../support/api";

fullRegression("LEGACY-083", "One error handler in 33,179 lines, and it swallows the error", {
  "a database error is classified and surfaced, never swallowed into a success": async ({
    api,
    a,
    expect,
  }) => {
    const body = { code: "LEGACY083", name: "First", baseCurrency: "MYR" };
    expect(
      (await api.request({ method: "POST", path: "/v1/companies", as: a.human, body })).status,
    ).toBe(201);

    // A DIFFERENT Idempotency-Key, so the reservation cannot mask it: the unique violation reaches the handler.
    const dup = await api.request({ method: "POST", path: "/v1/companies", as: a.human, body });
    expect(dup.status).toBe(409);
    const problem = await problemOf(dup);
    expect(problem.code).toBe("ERR_CONFLICT_UNIQUE");
    expect(problem.status).toBe(409);
  },

  "no thrown registry code can be answered with a 2xx — every Problem is a failure": async ({
    expect,
  }) => {
    expect(
      Object.entries(ERRORS)
        .filter(([, def]) => def.status < 400)
        .map(([code]) => code)
        .toSorted(),
    ).toEqual(["ERR_SYNC_MESSAGE_UNSUPPORTED", "ERR_SYNC_TICKET_REJECTED"]);
    for (const [code, def] of Object.entries(ERRORS)) {
      const app = new Hono<AppEnv>();
      app.onError((error, context) => toProblemResponse(context, error));
      if (code === "ERR_SYNC_TICKET_REJECTED" || code === "ERR_SYNC_MESSAGE_UNSUPPORTED")
        expect(def.status).toBe(200);
      else expect(def.status, code).toBeGreaterThanOrEqual(400);
      expect(def.status, code).toBeLessThan(600);
      app.get(`/${code}`, (context) => {
        context.set("requestId", "legacy-083");
        throw new AppError(code as ErrCode, "a thrown error must surface");
      });
      const response = await app.request(`http://local/${code}`);
      expect(response.status, code).toBe(def.status < 400 ? 422 : def.status);
      expect(response.status, code).toBeGreaterThanOrEqual(400);
      expect(response.status, code).toBeLessThan(600);
      const problem = (await response.json()) as Problem;
      expect(problem).toMatchObject({ code, status: response.status, requestId: "legacy-083" });
    }
    // Containment, not equality: 0D and every later slice add codes to this registry and may not edit this
    // block (contracts §3.7.3), so the assertion is that 0B's own twenty-five are still all present.
    for (const code of [
      "ERR_VALIDATION_FAILED",
      "ERR_IDEMPOTENCY_KEY_MISSING",
      "ERR_AUTH_TOKEN_INVALID",
      "ERR_AUTH_AAL_INSUFFICIENT",
      "ERR_AUTH_NO_MEMBERSHIP",
      "ERR_RBAC_FORBIDDEN",
      "ERR_RLS_DENIED",
      "ERR_NOT_FOUND",
      "ERR_RBAC_SELF_GRANT",
      "ERR_RBAC_SELF_ESCALATION",
      "ERR_RBAC_KIND",
      "ERR_RBAC_LAST_ADMIN",
      "ERR_ACTOR_IMMUTABLE",
      "ERR_TABLE_IMMUTABLE",
      "ERR_IDEMPOTENCY_KEY_REUSED",
      "ERR_IDEMPOTENCY_IN_FLIGHT",
      "ERR_CONFLICT_UNIQUE",
      "ERR_CONFLICT_REFERENCE",
      "ERR_LEDGER_UNBALANCED",
      "ERR_PERIOD_NOT_OPEN",
      "ERR_TENANT_CONTEXT_MISSING",
      "ERR_TENANT_CONTEXT_NESTED",
      "ERR_DB_POOLER_URL",
      "ERR_ROUTE_GATE_READONLY",
      "ERR_INTERNAL",
    ]) {
      expect(Object.keys(ERRORS)).toContain(code);
    }
  },

  "every failure carries the request id that finds it in the log": async ({ api, a, expect }) => {
    const res = await api.request({
      method: "GET",
      path: `/v1/companies/${a.tenant}`,
      as: a.human,
    });
    expect(res.status).toBe(404);
    const problem = await problemOf(res);
    expect(problem.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.headers.get("X-Request-Id")).toBe(problem.requestId);
  },
});
