export interface RateLimitBinding {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}
export type PrecheckResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "missing" | "malformed" | "expired" | "issuer" };
export interface EnvSecrets {
  readonly DATABASE_URL: string;
  /** 6A — the HS256 key the API signs terminal JWTs with (contracts §3.11). Required, like DATABASE_URL: the
   *  API container's readConfig() exits 2 without it. Forwarded to the API container only, never the worker. */
  readonly TERMINAL_JWT_SIGNING_KEY: string;
  readonly SUPABASE_URL?: string;
  readonly SUPABASE_JWKS_URL?: string;
  readonly SUPABASE_JWT_AUDIENCE?: string;
  readonly SENTRY_DSN?: string;
  readonly OTEL_EXPORTER_OTLP_ENDPOINT?: string;
  /** 2C — the container talks to R2 through its S3 endpoint (ADR 0031); the four §3.11 R2 names. */
  readonly R2_ACCOUNT_ID?: string;
  readonly R2_ATTACHMENTS_BUCKET?: string;
  readonly R2_ACCESS_KEY_ID?: string;
  readonly R2_SECRET_ACCESS_KEY?: string;
  /** 2C — a host-installed Chromium for the print engine; unset, Playwright uses its own pinned build. */
  readonly CHROMIUM_EXECUTABLE_PATH?: string;
  /** Phase 5: transmitter credential supplied to both containers; never stored in company settings. */
  readonly EINVOICE_CLIENT_SECRET?: string;
  /** 8A — §3.11's HR field-encryption key, base64 of exactly 32 bytes (amendment A8, ADR 0071), and the previous
   *  key while 8D's rotation runs. Optional here as the R2 names are: readConfig() refuses a staging or production
   *  API container that lacks the current one. */
  readonly HR_FIELD_ENCRYPTION_KEY?: string;
  readonly HR_FIELD_ENCRYPTION_KEY_PREVIOUS?: string;
  /** 8D A1 — the envelope version the current key seals under; optional, default 1 (both containers read it). */
  readonly HR_FIELD_ENCRYPTION_KEY_VERSION?: string;
  /** 9B (round 20 C10) — the legacy Firebird database the admin.import.run handler reads, as an ODBC connection
   *  string. The WORKER's alone, and only for the cut-over: the runbook removes it once the load is signed off. */
  readonly LEGACY_ODBC_DSN?: string;
  /** 9B review, finding 1 (round 20 C19) — `<tenantId>:<companyId>`, the ONE company the configured LEGACY_ODBC_DSN
   *  may be loaded into. Not a secret, but bound and removed with the DSN; the worker refuses every run without it. */
  readonly LEGACY_IMPORT_TARGET?: string;
  readonly LOG_LEVEL?: string;
}
export interface Env extends EnvSecrets {
  readonly API: DurableObjectNamespace<Container<Env>>;
  readonly WORKER: DurableObjectNamespace<Container<Env>>;
  readonly UPDATE_FEED: R2Bucket;
  readonly ATTACHMENTS: R2Bucket;
  readonly RATE_LIMIT: RateLimitBinding;
  readonly APP_ENV: "dev" | "staging" | "production";
  readonly SUPABASE_JWT_ISSUER: string;
}
import type { Container } from "@cloudflare/containers";
