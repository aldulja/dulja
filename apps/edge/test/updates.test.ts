import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { serveUpdate } from "../src/updates";

const DESKTOP = join(dirname(fileURLToPath(import.meta.url)), "../../desktop");

/**
 * The file name electron-builder writes into `latest.yml` (`url:`, app-builder-lib's
 * `updateInfoBuilder` takes `path.basename` of the artefact, spaces kept), from the config's own
 * `win.artifactName` and the package's version. Read from the config rather than restated, so a
 * rename that reintroduces a space fails here and not on a till in the field.
 */
function generatedFileName(config: string): string {
  const text = readFileSync(join(DESKTOP, config), "utf8");
  const pattern = /^\s+artifactName:\s*(.+)$/m.exec(text)?.[1]?.trim();
  if (pattern === undefined) throw new Error(`${config} declares no win.artifactName`);
  const productName = /^productName:\s*(.+)$/m.exec(text)?.[1]?.trim() ?? "";
  const { version } = JSON.parse(readFileSync(join(DESKTOP, "package.json"), "utf8")) as {
    version: string;
  };
  return pattern
    .replace(/^["']|["']$/g, "")
    .replaceAll("${productName}", productName)
    .replaceAll("${version}", version)
    .replaceAll("${ext}", "exe");
}

const bucket = (present: Record<string, string>) =>
  ({
    async get(key: string) {
      const body = present[key];
      return body === undefined
        ? null
        : { body: new Blob([body]).stream(), httpEtag: `"${key}"`, size: body.length };
    },
  }) as unknown as R2Bucket;

describe("apps/edge/src/updates — the electron-builder feed from R2 (spec:1104, §5.2)", () => {
  it("serves a present object with its etag", async () => {
    const res = await serveUpdate(
      bucket({ "latest.yml": "version: 1.0.0" }),
      "/updates/latest.yml",
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("ETag")).toBe('"latest.yml"');
    expect(await res.text()).toBe("version: 1.0.0");
  });

  it("404s a missing object without revealing whether the bucket has anything else", async () => {
    const res = await serveUpdate(bucket({}), "/updates/latest.yml");
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("not found");
  });

  it("refuses path traversal and an empty key — the feed is not a file browser (LEGACY-038)", async () => {
    for (const p of ["/updates/../wrangler.jsonc", "/updates/a/../../b", "/updates/"]) {
      expect((await serveUpdate(bucket({}), p)).status).toBe(400);
    }
  });

  // OPS-03: electron-updater resolves `latest.yml`'s `url:` against the feed base (`newUrlFromBase`, which
  // is `new URL(name, base)`) and requests that pathname. A space in the artefact name arrives as `%20`,
  // which `safeKey` refuses, so the download could never start for either product.
  for (const [config, prefix] of [
    ["electron-builder.yml", "backoffice"],
    ["electron-builder.pos.yml", "pos"],
  ] as const) {
    it(`serves the installer electron-updater asks for after reading ${prefix}'s latest.yml`, async () => {
      const name = generatedFileName(config);
      const requested = new URL(name, `https://api.dulja.example/updates/${prefix}/`).pathname;
      const res = await serveUpdate(bucket({ [`${prefix}/${name}`]: "installer" }), requested);
      expect(res.status, `${requested}`).toBe(200);
      expect(await res.text()).toBe("installer");
    });
  }
});
