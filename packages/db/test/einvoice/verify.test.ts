import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { startStubServer, type StubServer } from "../support/einvoice-stub";
import { formatVerifyResult, verifyProfile } from "../../src/einvoice/verify";

let stub: StubServer;
const execFileAsync = promisify(execFile);

beforeAll(async () => {
  stub = await startStubServer({
    submit: { state: "queued", receiptId: "V-1" },
    poll: { state: "cleared" },
    cancel: { state: "withdrawn" },
  });
});
afterAll(async () => {
  await stub.stop();
});

describe("einvoice:verify (5B T9, hazard 5's local equivalent)", () => {
  it("prints the four lines for `synthetic` with the secret set", async () => {
    // `stub.profile` carries the port the stub actually bound; the committed file says port 0.
    const r = await verifyProfile("synthetic", {
      profile: stub.profile,
      env: { EINVOICE_CLIENT_SECRET: "stub-secret" },
    });
    expect(r).toEqual({ profile: "ok", schema: "ok", credentials: "present", reachable: "ok" });
    expect(formatVerifyResult(r)).toBe(
      "profile: ok\nschema: ok\ncredentials: present\nreachable: ok",
    );
  });

  it("names the missing environment variable rather than failing opaquely", async () => {
    const r = await verifyProfile("synthetic", { env: {} });
    expect(r.profile).toBe("ok");
    expect(r.schema).toBe("ok");
    expect(r.credentials).toContain("EINVOICE_CLIENT_SECRET");
    expect(r.reachable).toBe("not checked");
  });

  it("names the profile that does not exist", async () => {
    const r = await verifyProfile("nosuch", { env: { EINVOICE_CLIENT_SECRET: "x" } });
    expect(r.profile).toContain("nosuch");
    expect(r.schema).toBe("not checked");
  });

  it("the actual CLI verifies the ephemeral loopback port without editing the pinned profile", async () => {
    const { stdout, stderr } = await execFileAsync(
      "bun",
      [
        "run",
        "src/cli.ts",
        "einvoice-verify",
        "--profile",
        "synthetic",
        "--base-url",
        stub.profile.baseUrl,
      ],
      {
        cwd: fileURLToPath(new URL("../..", import.meta.url)),
        env: { ...process.env, EINVOICE_CLIENT_SECRET: "cli-local-secret" },
        timeout: 15_000,
      },
    );
    expect(stdout.trim()).toBe("profile: ok\nschema: ok\ncredentials: present\nreachable: ok");
    expect(stdout + stderr).not.toContain("cli-local-secret");
    expect(stub.calls.at(-1)?.headers.authorization).toBe("Bearer cli-local-secret");
  });

  it.each([
    "http://example.test:1234",
    "http://user:secret@127.0.0.1:1234",
    "http://127.0.0.1:1234/path?secret=value",
    "http://127.0.0.1:65536",
  ])(
    "refuses a non-origin/invalid synthetic override before credentials or HTTP: %s",
    async (baseUrl) => {
      const before = stub.calls.length;
      const result = await verifyProfile("synthetic", { baseUrl, env: {} });
      expect(result.schema).toContain("explicit loopback port");
      expect(result.credentials).toBe("not checked");
      expect(result.reachable).toBe("not checked");
      expect(stub.calls).toHaveLength(before);
      expect(formatVerifyResult(result)).not.toContain("secret");
    },
  );

  it("never overrides an authority profile's host", async () => {
    const before = stub.calls.length;
    const result = await verifyProfile("myinvois", {
      profile: { ...stub.profile, code: "myinvois" },
      baseUrl: stub.profile.baseUrl,
      env: {},
    });
    expect(result.schema).toContain("requires the synthetic profile");
    expect(result.reachable).toBe("not checked");
    expect(stub.calls).toHaveLength(before);
  });

  it("reports an unreachable base URL without throwing", async () => {
    const dead = stub.profile;
    await stub.stop();
    const r = await verifyProfile("synthetic", {
      profile: dead,
      env: { EINVOICE_CLIENT_SECRET: "stub-secret" },
    });
    expect(r.credentials).toBe("present");
    expect(r.reachable).toMatch(/^no answer: /);
    stub = await startStubServer({
      submit: { state: "queued", receiptId: "V-1" },
      poll: { state: "cleared" },
      cancel: { state: "withdrawn" },
    });
  });
});
