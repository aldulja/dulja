import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * `../backoffice/dist` is a build output this app never imports from (spec:2389) — Task 5 (running in
 * parallel with this one) is what produces it for real, via the `@dulja/desktop#build` -> `@dulja/backoffice#build`
 * turbo edge. On a checkout where that build has not run yet, `main.ts`'s `protocol.handle` has nothing
 * to serve and the app fails to load anything, which tells us nothing about the security posture the
 * specs in this directory exist to check. So: write a placeholder shell only when no build output is
 * already there. A real build is left alone.
 */
export default function globalSetup(): void {
  const dist = resolve(__dirname, "../../backoffice/dist");
  const indexHtml = resolve(dist, "index.html");
  if (existsSync(indexHtml)) return;
  mkdirSync(dist, { recursive: true });
  writeFileSync(indexHtml, "<!DOCTYPE html>\n<html>\n<head></head>\n<body></body>\n</html>\n");
}
