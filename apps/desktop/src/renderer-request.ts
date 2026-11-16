import { join, normalize, sep } from "node:path";

export interface RendererRequest {
  /** The absolute file path to serve — always inside `rendererDir`. */
  readonly target: string;
  /** Whether `target` is the requested asset itself, as opposed to the SPA shell fallback. */
  readonly isAsset: boolean;
}

/**
 * Maps a `dulja://app/<path>` request to a file under `rendererDir`, containment-checked and
 * SPA-shell-fallback by design (unresolved client-side routes fall through to `index.html`, never a
 * 404). Pulled out of `main.ts`'s `protocol.handle` closure specifically so this — the one place a
 * hostile renderer's request string reaches a filesystem path — is unit-testable without launching
 * Electron.
 */
export function resolveRendererRequest(rendererDir: string, requestUrl: string): RendererRequest {
  const { pathname } = new URL(requestUrl);
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    // A malformed escape (e.g. `%zz`) is renderer-triggerable — fail safe to the SPA shell rather than
    // letting `decodeURIComponent` throw out of the protocol handler.
    decoded = "/";
  }
  const candidate = normalize(join(rendererDir, decoded));
  // `rendererDir + sep`, not `rendererDir`: a bare prefix check also admits a *sibling* directory that
  // merely starts with the same characters (`.../dist-evil` starts with `.../dist`). The extension test
  // runs against the decoded path, not the raw one — the raw, still-percent-encoded pathname never
  // contains a literal `.` for an escaped one (`logo%2Epng`), so it always missed real assets.
  const inside = candidate.startsWith(rendererDir + sep);
  const isAsset = inside && /\.[a-z0-9]+$/i.test(decoded);
  return { target: isAsset ? candidate : join(rendererDir, "index.html"), isAsset };
}
