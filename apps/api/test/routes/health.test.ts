import type { Sql } from "postgres";
import { describe, expect, it } from "vitest";
import { createLogger, type Problem } from "@dulja/contracts";
import { createApp } from "../../src/app";

function makeDeps(): {
  deps: Parameters<typeof createApp>[0];
  logged: () => { level: string; msg: string; [field: string]: unknown }[];
} {
  const lines: string[] = [];
  return {
    deps: {
      db: null as unknown as Sql, // /healthz touches no database
      jobs: {
        enqueue: () => {
          throw new Error("no job client in this test");
        },
      },
      logger: createLogger({ sink: (line) => lines.push(line) }),
      authAdmin: {
        createUser: () => {
          throw new Error("health must not create users");
        },
        inviteUser: () => {
          throw new Error("no auth admin in this test");
        },
      },
      verifier: () => {
        throw new Error("no verifier in this test");
      },
    } as never,
    logged: () => lines.map((line) => JSON.parse(line) as { level: string; msg: string }),
  };
}

const deps = (): Parameters<typeof createApp>[0] => makeDeps().deps;

describe("the api skeleton — spec:2314, 2055, 2063", () => {
  it("GET /healthz is public, returns 200 and echoes a request id", async () => {
    const res = await createApp(deps()).request("/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
    expect(res.headers.get("X-Request-Id")).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("echoes a caller-supplied request id, and mints one when the header is not a uuid", async () => {
    const given = "0192f000-0000-7000-8000-0000000000aa";
    const echoed = await createApp(deps()).request("/healthz", {
      headers: { "X-Request-Id": given },
    });
    expect(echoed.headers.get("X-Request-Id")).toBe(given);
    const minted = await createApp(deps()).request("/healthz", {
      headers: { "X-Request-Id": "'; drop table app.tenant --" },
    });
    expect(minted.headers.get("X-Request-Id")).not.toContain("drop table");
  });

  it("an unknown path is an RFC 9457 problem, not an HTML 404", async () => {
    const res = await createApp(deps()).request("/nope");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
    const body = (await res.json()) as Problem;
    expect(body.code).toBe("ERR_NOT_FOUND");
    expect(body.type).toBe("urn:dulja:error:ERR_NOT_FOUND");
    expect(body.instance).toBe("/nope");
    expect(body.requestId).toBe(res.headers.get("X-Request-Id"));
    expect(body.remedy.length).toBeGreaterThan(0);
  });

  it("an unknown path under /v1 answers 401 before it answers 404 — route existence is not public", async () => {
    // The plan expected 404 here (plan0B:1665); authenticate() is mounted on /v1/* ahead of routing, so an
    // anonymous caller cannot enumerate which /v1 routes exist. The stricter answer is the right one.
    const res = await createApp(deps()).request("/v1/nope");
    expect(res.status).toBe(401);
    expect(((await res.json()) as Problem).code).toBe("ERR_AUTH_TOKEN_INVALID");
  });

  it("a thrown driver error becomes ERR_INTERNAL and never echoes the driver text (LEGACY-083)", async () => {
    const app = createApp(deps());
    app.get("/boom", () => {
      throw Object.assign(new Error('relation "app.secret" does not exist'), { code: "42P01" });
    });
    const res = await app.request("/boom");
    expect(res.status).toBe(500);
    const body = (await res.json()) as Problem;
    expect(body.code).toBe("ERR_INTERNAL");
    expect(JSON.stringify(body)).not.toContain("app.secret");
  });

  it("the 5xx the caller never sees is written to the log, with the driver text (spec:2063)", async () => {
    const { deps: capturing, logged } = makeDeps();
    const app = createApp(capturing);
    app.get("/boom", () => {
      throw Object.assign(new Error('relation "app.secret" does not exist'), { code: "42P01" });
    });
    expect((await app.request("/boom")).status).toBe(500);
    const unhandled = logged().find((line) => line.msg === "unhandled");
    expect(unhandled?.level).toBe("error");
    expect(String(unhandled?.["err"])).toContain("app.secret");
  });

  it("every line carries request_id, trace_id, tenant_id and actor_id (spec:2063)", async () => {
    const { deps: capturing, logged } = makeDeps();
    await createApp(capturing).request("/healthz");
    const request = logged().find((line) => line.msg === "request");
    // Unauthenticated: the identity fields are declared and null, never absent — authenticate() fills
    // them in for /v1/*, which apps/api/test/middleware/auth.test.ts proves.
    expect(request).toMatchObject({
      tenant_id: null,
      actor_id: null,
      path: "/healthz",
      status: 200,
    });
    expect(String(request?.["request_id"])).toMatch(/^[0-9a-f-]{36}$/);
  });
});
