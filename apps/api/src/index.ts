import { registerDefaultTransmitters } from "@dulja/db";
import { createLogger } from "@dulja/contracts";
import { createDb, createHrKeyRing, startEnqueueClient } from "@dulja/db";
import { createApp } from "./app";
import { createAuthAdmin } from "./auth-admin";
import { ConfigError, readConfig, type ApiConfig } from "./config";
import { objectStoreFromConfig } from "./object-store";
import { pgDebugTracer, startTelemetry } from "./otel";
import { configureChromium } from "./print/engines";
import type { AuthAdmin } from "./ports";
import { startSentry } from "./sentry";
import { createJwtVerifier } from "./verifier";

let config: ApiConfig;
let authAdmin: AuthAdmin;
try {
  config = readConfig();
  // Which identity-provider adapter this process may use is configuration, so its refusal is read here,
  // with the rest, and exits 2 like any other. A serving process must never reach `fetch` with the stub
  // outside dev — see `createAuthAdmin` for what a 201 from it costs.
  authAdmin = createAuthAdmin(config);
} catch (error) {
  if (error instanceof ConfigError) {
    process.stderr.write(`${error.message}\n`);
    process.exit(2);
  }
  throw error;
}

startTelemetry({ serviceName: "dulja-api", appEnv: config.appEnv });
startSentry({ appEnv: config.appEnv, serviceName: "dulja-api" });
configureChromium({ executablePath: config.chromiumExecutablePath });

const logger = createLogger({ level: config.logLevel, base: { app_env: config.appEnv } });
// Never throws: a profile version that cannot be loaded is left unregistered — its callers get
// ERR_EINVOICE_TRANSMITTER_UNAVAILABLE — and reported here, so one integration cannot keep the API down.
for (const { code, version, reason } of registerDefaultTransmitters(config.appEnv).skipped)
  logger.warn(
    { transmitter: code, profileVersion: version ?? null, reason },
    "e-invoice transmitter not registered",
  );
// The real pg-boss client, send-only. postDocument's step 14 enqueues accounting.projection.rebuild for every
// document that names a party or moves stock (4B), and 3B's replay for every back-dated one, on the posting
// transaction — the stub that threw here would have failed each of those posts. Its `error` events are logged:
// with no listener an idle-connection drop would be an uncaught EventEmitter error and kill the process (code
// review 2026-09-29). The handle is KEPT, so shutdown below can close its pool.
const enqueue = await startEnqueueClient(config.databaseUrl, {
  onError: (error) => logger.error({ err: String(error) }, "pg-boss enqueue client error"),
});
const app = createApp({
  terminalJwtSigningKey: new TextEncoder().encode(config.terminalJwtSigningKey),
  db: createDb(config.databaseUrl, { debug: pgDebugTracer() }),
  jobs: enqueue.jobs,
  logger,
  authAdmin,
  objectStore: objectStoreFromConfig(config),
  // 8A (amendment A8). readConfig() has already validated both keys and the version. 8D A1 replaced 8A's literal
  // `currentVersion: 1`: the API must seal new writes under the same version the worker's rotation re-seals under.
  hrKeys: createHrKeyRing({
    current: config.hrFieldEncryptionKey,
    currentVersion: config.hrFieldEncryptionKeyVersion,
    previous: config.hrFieldEncryptionKeyPrevious,
  }),
  verifier: createJwtVerifier({
    jwksUrl: config.supabaseJwksUrl,
    issuer: config.supabaseJwtIssuer,
    audience: config.supabaseJwtAudience,
  }),
});
logger.info({ port: config.port }, "api listening");

// Shutdown: close the enqueue client's pool before exiting. A listener on a signal replaces the default exit,
// so the handler exits itself — once, whichever signal comes first.
const shutdown = (signal: string): void => {
  logger.info({ signal }, "api stopping");
  enqueue.stop().then(
    () => process.exit(0),
    (error: unknown) => {
      logger.error({ err: String(error) }, "pg-boss enqueue client did not stop cleanly");
      process.exit(1);
    },
  );
};
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);

export default { port: config.port, fetch: app.fetch };
