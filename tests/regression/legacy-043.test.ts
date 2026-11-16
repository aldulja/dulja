import { fullRegression, problemOf } from "../support/api";

fullRegression("LEGACY-043", "Failed authentication returns a row instead of raising", {
  "every failure shape is a problem document with a 401 status, never a body of data": async ({
    api,
    expect,
  }) => {
    const forged =
      "eyJhbGciOiJSUzI1NiIsImtpZCI6InRlc3Qta2V5IiwidHlwIjoiSldUIn0.eyJzdWIiOiJ4In0.AAAA";
    for (const token of [forged, "Bearer", "", "null", "undefined"]) {
      const res = await api.request({
        method: "GET",
        path: "/v1/session",
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(401);
      expect(res.headers.get("content-type")).toMatch(/application\/problem\+json/);
      const problem = await problemOf(res);
      expect(problem.code).toBe("ERR_AUTH_TOKEN_INVALID");
      expect(problem.status).toBe(401);
    }
  },

  "a valid signature over a subject with no membership is refused, and says so distinctly": async ({
    api,
    expect,
  }) => {
    const res = await api.request({
      method: "GET",
      path: "/v1/session",
      as: "00000000-0000-7000-8000-00000000dead",
    });
    expect(res.status).toBe(403);
    expect((await problemOf(res)).code).toBe("ERR_AUTH_NO_MEMBERSHIP");
  },

  "resolve_principal answers with zero rows for an unknown subject — it does not invent one":
    async ({ api, expect }) => {
      const rows = await api.db.admin<
        { principal_id: string }[]
      >`select * from app.resolve_principal('supabase:not-a-user')`;
      expect(rows).toEqual([]);
    },
});
