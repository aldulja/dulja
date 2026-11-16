import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { extname } from "node:path";
import { resolveRendererRequest } from "../../../apps/desktop/src/renderer-request";
import { CONTENT_SECURITY_POLICY } from "../../../apps/desktop/src/window-options";

const MIME: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

export interface ServedRenderer {
  /** The till's page, `/index.html`, as `main-pos.ts` loads it. The back office opens the origin's root, as
   *  `main.ts` does (its router has no `/index.html` route), so a back-office spec uses `${origin}/`. */
  url: string;
  origin: string;
  close(): Promise<void>;
}

/**
 * A built renderer (`apps/pos/dist` or `apps/backoffice/dist`) on an ephemeral loopback port, never a fixed
 * one, so this cannot collide with the back office's 4173 or the API's 8787. Each request goes through
 * `resolveRendererRequest`, the containment check and shell fallback `dulja://app` uses, and every answer
 * carries the desktop's CSP, so a renderer that needed inline style or script, or `eval`, fails here the way
 * it would in `pos.exe` or `backoffice.exe`.
 */
export async function serveRenderer(dir: string, name: string): Promise<ServedRenderer> {
  const server: Server = createServer((request, response) => {
    const { target } = resolveRendererRequest(dir, `http://${name}${request.url ?? "/"}`);
    readFile(target).then(
      (body) => {
        response.writeHead(200, {
          "content-type": MIME[extname(target)] ?? "application/octet-stream",
          "content-security-policy": CONTENT_SECURITY_POLICY,
        });
        response.end(body);
      },
      () => {
        response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        response.end(`no such file in the built ${name}: ${request.url ?? "/"}`);
      },
    );
  });
  await new Promise<void>((done, fail) => {
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => done());
  });
  const origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  return {
    url: `${origin}/index.html`,
    origin,
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}
