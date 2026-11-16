import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * `base: "/"` because the packaged app is served from the custom `dulja://app` origin registered in
 * apps/desktop, **not** from `file://` — a real origin is what makes CSP, `localStorage` and the
 * navigation lock work. `dist/` is the directory that app's `protocol.handle` serves; nothing in
 * this repository imports across that boundary (spec:2389).
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: "/",
  build: { outDir: "dist", sourcemap: true, emptyOutDir: true },
  server: { port: 5173, strictPort: true },
});
