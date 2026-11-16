import { z } from "zod";

/**
 * Imported FIRST by `main.tsx`, before anything that builds a schema. `backoffice.exe` runs this renderer under
 * `script-src 'self'` with no `'unsafe-eval'` (`apps/desktop/src/window-options.ts`). Without this, zod probes
 * for `new Function` the first time it builds an object schema: the probe's throw is caught, but the policy
 * still reports a violation for it. Zod reads the setting as each object schema is built, so it must be set
 * before `@dulja/contracts` loads. The server keeps zod's JIT; this module is the renderer's alone.
 */
z.config({ jitless: true });
