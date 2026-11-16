// packages/db/src/einvoice/registry.ts
//
// (code, profile version) -> transmitter, for the process. Both the API and the worker call
// registerDefaultTransmitters() once at boot; nothing constructs a transmitter ad hoc.

import { EInvoiceError } from "./errors";
import type { RegisteredTransmitter } from "./http-transmitter";
import { availableProfileVersions, loadProfile, PROFILE_DIR } from "./profile";
import { createSyntheticTransmitter } from "./synthetic";

// `RegisteredTransmitter` is imported as a TYPE and is NOT re-exported from here. It has exactly one
// home, `http-transmitter.ts`, and the barrel (Task 5 Step 5) takes it from that home alone — one
// exported name, one declaration.

export type TransmitterCode = "synthetic" | "myinvois";
export const TRANSMITTER_CODES: readonly TransmitterCode[] = ["synthetic", "myinvois"];

/**
 * Every profile version of a code this process can serve, and the one a NEW submission uses.
 *
 * ADR 0053, "Also open" (PR 11 review): a row is pinned to the `profile_version` it was submitted
 * under (SAH-013), and its poll and cancel must be interpreted against that file. One transmitter
 * per code, built from the highest file, stranded every `submitted` or `accepted` row of v1 the day
 * `<code>.v2.json` shipped. `latest` is the highest version the deployment SHIPS — not the highest
 * that happened to build — so a broken newest file refuses new submissions (fail closed, ADR 0052)
 * instead of sending them quietly under an older version the authority may no longer accept.
 */
interface CodeRegistration {
  readonly versions: Map<number, RegisteredTransmitter>;
  latest: number;
}

const registry = new Map<TransmitterCode, CodeRegistration>();

/**
 * Register `transmitter` under `code` at its own `profile.version`, beside any other version of the
 * code; the same version is replaced. The highest version registered this way is the one a new
 * submission uses. Tests register a stub-server transmitter through this; boot goes through
 * `registerDefaultTransmitters`.
 */
export function registerTransmitter(
  code: TransmitterCode,
  transmitter: RegisteredTransmitter,
): void {
  const version = transmitter.profile.version;
  const entry = registry.get(code);
  if (entry === undefined) {
    registry.set(code, { versions: new Map([[version, transmitter]]), latest: version });
    return;
  }
  entry.versions.set(version, transmitter);
  entry.latest = Math.max(entry.latest, version);
}

/**
 * The fail-closed door. A code with no registered transmitter — `myinvois` before OD-15, or
 * `synthetic` in production, or any code whose profile files all failed to parse at boot — is
 * ERR_EINVOICE_TRANSMITTER_UNAVAILABLE, naming what IS registered so an operator can see the
 * difference between "not deployed here" and "misconfigured".
 *
 * `version` is the profile version a transmission row is pinned to (`profile_version`): poll and
 * cancel pass it, so a row submitted under v1 is still served by v1 after v2 ships. A version that
 * is not registered is the same refusal, naming the version and those that are — none, when no
 * version of the code built. Omitted — a new submission, or a row never submitted — it is the
 * code's highest shipped version, which is refused in the same way when that file did not build.
 */
export function transmitterFor(code: string, version?: number): RegisteredTransmitter {
  const entry = registry.get(code as TransmitterCode);
  const wanted = version ?? entry?.latest;
  if (wanted === undefined) {
    throw new EInvoiceError(
      "ERR_EINVOICE_TRANSMITTER_UNAVAILABLE",
      `transmitter ${code} is not registered in this deployment (registered: ${registeredTransmitters().join(", ") || "none"})`,
    );
  }
  const found = entry?.versions.get(wanted);
  if (found === undefined) {
    throw new EInvoiceError(
      "ERR_EINVOICE_TRANSMITTER_UNAVAILABLE",
      `transmitter ${code} profile version ${wanted} is not registered in this deployment (registered versions of ${code}: ${
        [...(entry?.versions.keys() ?? [])].toSorted((a, b) => a - b).join(", ") || "none"
      })`,
    );
  }
  return found;
}

/** The codes with at least one registered version. */
export function registeredTransmitters(): TransmitterCode[] {
  return TRANSMITTER_CODES.filter((c) => (registry.get(c)?.versions.size ?? 0) > 0);
}

/** Test-only: the registry is process state and Vitest reuses the process across files. */
export function resetTransmitters(): void {
  registry.clear();
}

/**
 * Called once from each entrypoint. `synthetic` is registered in `dev` and `staging` and NOT in
 * `production` — a transmitter that manufactures acceptances must not be reachable on a real
 * company (ADR 0052 decision 6).
 *
 * The `myinvois` transmitter remains unregistered until Task 9's mapping, signing and accepted
 * profile are supplied. The public transport module alone does not activate it. A company set to
 * it gets ERR_EINVOICE_TRANSMITTER_UNAVAILABLE, §2.12's OD-15 default made visible.
 *
 * **Every version** of a code it registers is built — each `<code>.v<N>.json` in the profile
 * directory — so a row is served by the version it is pinned to (`transmitterFor(code, version)`).
 * The code's entry is replaced as a whole: a version a later call no longer finds, or can no longer
 * build, does not outlive it.
 *
 * It never throws. Both entrypoints call it at module top level, so a transmitter that cannot be
 * constructed — its profile directory missing from the image, a file that is not JSON or fails the
 * schema — would otherwise crash-loop the whole process over one integration. Every construction
 * goes through `attempt`, which leaves such a version unregistered (fail closed: its callers get
 * ERR_EINVOICE_TRANSMITTER_UNAVAILABLE from `transmitterFor`) and returns it in `skipped` with its
 * version and the reason, which each entrypoint logs at WARN. A code with no profile file at all is
 * one skip with no version. `skipped` names only a code this environment meant to register;
 * production's missing `synthetic` and the unregistered authority transmitter are policy, not faults.
 *
 * `opts.profileDir` defaults to PROFILE_DIR, and `opts.env` to `process.env` (where the
 * transmitters read their secret, `readSecret`); both are passed only by tests.
 */
export function registerDefaultTransmitters(
  appEnv: "dev" | "staging" | "production",
  opts: { profileDir?: string; env?: Record<string, string | undefined> } = {},
): TransmitterRegistration {
  const report: TransmitterRegistration = { registered: [], skipped: [] };
  const registerVersions = (
    code: TransmitterCode,
    create: (version: number | undefined) => RegisteredTransmitter,
  ): void => {
    // An earlier registration of the code must not outlive what this call reports.
    registry.delete(code);
    const shipped = availableProfileVersions(code, opts.profileDir ?? PROFILE_DIR);
    const entry: CodeRegistration = { versions: new Map(), latest: shipped.at(-1) ?? 0 };
    // No file at all is one attempt at "the highest", so the skip carries the loader's own
    // ProfileNotFoundError naming the directory, exactly as it did before versions were separate.
    for (const version of shipped.length === 0 ? [undefined] : shipped) {
      try {
        const transmitter = create(version);
        entry.versions.set(transmitter.profile.version, transmitter);
      } catch (error) {
        report.skipped.push({
          code,
          ...(version === undefined ? {} : { version }),
          reason: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        });
      }
    }
    if (entry.versions.size === 0) return;
    registry.set(code, entry);
    report.registered.push(code);
  };
  if (appEnv !== "production") {
    registerVersions("synthetic", (version) =>
      createSyntheticTransmitter({
        profile: loadProfile("synthetic", version, opts.profileDir),
        ...(opts.env === undefined ? {} : { env: opts.env }),
      }),
    );
  }
  return report;
}

/**
 * What `registerDefaultTransmitters` did: the codes it registered at least one version of, and each
 * version it could not, with why. `version` is absent when the code has no profile file at all.
 */
export interface TransmitterRegistration {
  registered: TransmitterCode[];
  skipped: { code: TransmitterCode; version?: number; reason: string }[];
}
