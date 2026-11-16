import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import type { IncomingHttpHeaders } from "node:http";
import { createServer } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface StubRequest {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
}

export interface BackendStub {
  port: number;
  origin: string;
  requests: StubRequest[];
  close(): Promise<void>;
}

/** `openssl` on PATH (windows-latest carries one), else the copy Git for Windows ships. */
function openssl(): string {
  if (spawnSync("openssl", ["version"]).status === 0) return "openssl";
  const git = "C:\\Program Files\\Git\\usr\\bin\\openssl.exe";
  if (existsSync(git)) return git;
  throw new Error("the backend stub needs openssl to mint its throwaway certificate");
}

/**
 * A throwaway https server standing in for the deployed API and Supabase (OD-19/OD-20 have not supplied
 * either). It records every request and answers CORS for whatever origin asks — the packaged back office
 * sends `Origin: dulja://app` — then refuses the request itself with a 400, which is all a smoke test
 * needs: the request arrived, from the right origin, at the configured host.
 *
 * https because both products refuse anything else when packaged (the back office's CSP admits only
 * `https:`, the till's origin rule is ADR 0093). The certificate is self-signed and minted per run, and
 * only the test's own launch is told to accept it.
 */
export async function startBackendStub(): Promise<BackendStub> {
  const dir = await mkdtemp(join(tmpdir(), "dulja-stub-"));
  const key = join(dir, "key.pem");
  const cert = join(dir, "cert.pem");
  const made = spawnSync(
    openssl(),
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      key,
      "-out",
      cert,
      "-days",
      "1",
      "-subj",
      "/CN=127.0.0.1",
    ],
    { env: { ...process.env, MSYS_NO_PATHCONV: "1" }, encoding: "utf8" },
  );
  if (made.status !== 0) throw new Error(`openssl failed: ${made.stderr}`);
  const requests: StubRequest[] = [];
  const server = createServer(
    { key: await readFile(key), cert: await readFile(cert) },
    (request, response) => {
      requests.push({
        method: request.method ?? "",
        path: request.url ?? "",
        headers: request.headers,
      });
      const origin = request.headers.origin;
      if (origin !== undefined) {
        response.setHeader("Access-Control-Allow-Origin", origin);
        response.setHeader("Vary", "Origin");
      }
      if (request.method === "OPTIONS") {
        response.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE");
        response.setHeader(
          "Access-Control-Allow-Headers",
          request.headers["access-control-request-headers"] ?? "*",
        );
        response.writeHead(204).end();
        return;
      }
      request.resume();
      response.writeHead(400, { "content-type": "application/json" }).end(
        JSON.stringify({
          error: "invalid_grant",
          error_description: "stub",
          code: "ERR_VALIDATION",
          title: "stub",
          status: 400,
        }),
      );
    },
  );
  await new Promise<void>((settle) => server.listen(0, "127.0.0.1", settle));
  const { port } = server.address() as AddressInfo;
  return {
    port,
    origin: `https://127.0.0.1:${port}`,
    requests,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((settle) => server.close(() => settle()));
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/** Polls until `predicate` holds or `ms` passes; the stub's request log fills asynchronously. */
export async function eventually(predicate: () => boolean, ms = 30_000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (predicate()) return true;
    await new Promise((settle) => setTimeout(settle, 200));
  }
  return predicate();
}
