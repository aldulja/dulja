import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { grantCodes } from "@dulja/db/test";
import { ProblemSchema } from "@dulja/contracts";
import { startApi, type StartedApi } from "../../support/app";
import {
  posFixture,
  syncRequest,
  type PosFixture,
} from "../../../../../tests/invariants/support/pos";

describe("sync and terminal validation uses the shared Problem response", () => {
  let api: StartedApi;
  let f: PosFixture;
  beforeAll(async () => {
    api = await startApi();
    f = await posFixture(api, "Validation6C");
    await grantCodes(api.db, f.s, {
      principalId: f.supervisorId,
      roleCode: "validation-queue",
      codes: ["pos.needs_attention.resolve"],
    });
  }, 240000);
  afterAll(async () => api.stop());
  it.each(["enrol", "catalogue", "tickets", "terminals", "queue"])(
    "%s returns ERR_VALIDATION_FAILED without an ad hoc Zod payload",
    async (route) => {
      const response =
        route === "enrol"
          ? await api.request({ method: "POST", path: "/v1/sync/enrol", body: {} })
          : route === "catalogue"
            ? await syncRequest(api, f.terminal, {
                method: "GET",
                path: "/v1/sync/catalogue?limit=0",
              })
            : route === "tickets"
              ? await syncRequest(api, f.terminal, {
                  method: "POST",
                  path: "/v1/sync/tickets",
                  body: {},
                })
              : route === "terminals"
                ? await api.request({
                    as: f.s.human,
                    method: "POST",
                    path: "/v1/admin/terminals/enrolments",
                    body: { companyId: f.s.company },
                  })
                : await api.request({
                    as: f.supervisorId,
                    method: "GET",
                    path: `/v1/companies/${f.s.company}/needs-attention?limit=0`,
                  });
      expect(response.status).toBe(400);
      expect(response.headers.get("content-type")).toContain("application/problem+json");
      expect(ProblemSchema.parse(await response.json()).code).toBe("ERR_VALIDATION_FAILED");
    },
  );
});
