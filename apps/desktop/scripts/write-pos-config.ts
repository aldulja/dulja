/**
 * Bakes the till's API origin into the package (ADR 0093). Runs at packaging time, before electron-builder,
 * which copies `dist-config/pos-config.json` to `resources/pos-config.json` (`electron-builder.pos.yml`).
 * electron-builder carries no build-time environment into the packaged process (see `main.ts` on
 * `SENTRY_DSN`), so a file is the one way a value chosen at build time reaches the installed till.
 *
 * Unset writes an empty origin rather than failing, so a developer can still package locally to inspect the
 * tree; the packaged till then refuses to start and says why. `release.yml` refuses to build without it.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const apiBaseUrl = (process.env["DULJA_API_BASE_URL"] ?? "").trim();
const dir = join(import.meta.dir, "..", "dist-config");
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "pos-config.json"), `${JSON.stringify({ apiBaseUrl }, null, 2)}\n`);
process.stdout.write(`pos-config.json: apiBaseUrl=${apiBaseUrl === "" ? "(unset)" : apiBaseUrl}\n`);
