import { createHash } from "node:crypto";
import { AppError } from "@dulja/contracts";
import { ConfigError, type ApiConfig } from "./config";
import type { AuthAdmin, InvitedUser } from "./ports";

/** Server-side GoTrue administrative endpoints. */
const INVITE_PATH = "/auth/v1/invite";
const CREATE_PATH = "/auth/v1/admin/users";

export class SupabaseAuthAdmin implements AuthAdmin {
  constructor(
    private readonly options: {
      url: string;
      serviceRoleKey: string;
      invitePath: string;
      createPath: string;
    },
  ) {}

  /** The call runs inside the request's transaction (the idempotency middleware wraps the handler), so a
   *  hung provider would hold a pooled connection for as long as it liked without this bound. */
  static readonly TIMEOUT_MS = 10_000;

  inviteUser(email: string): Promise<InvitedUser> {
    return this.requestUser(email, this.options.invitePath, { email }, "invitation");
  }

  createUser(email: string): Promise<InvitedUser> {
    return this.requestUser(
      email,
      this.options.createPath,
      { email, email_confirm: true },
      "creation",
    );
  }

  private async requestUser(
    email: string,
    path: string,
    payload: { email: string; email_confirm?: boolean },
    operation: string,
  ): Promise<InvitedUser> {
    let response: Response;
    try {
      response = await fetch(new URL(path, this.options.url), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          apikey: this.options.serviceRoleKey,
          authorization: `Bearer ${this.options.serviceRoleKey}`,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(SupabaseAuthAdmin.TIMEOUT_MS),
      });
    } catch (error) {
      throw new AppError(
        "ERR_INTERNAL",
        `the identity provider did not answer the ${operation} for ${email}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    // GoTrue answers 422 (and some deployments 409) for an address it already holds — the cross-tenant
    // case the users route cannot see. That is the caller's conflict, not a server fault: a 500 here would
    // be recorded against the idempotency key and replayed as a 500 for the key's whole retention.
    if (response.status === 409 || response.status === 422)
      throw new AppError(
        "ERR_CONFLICT_UNIQUE",
        `the identity provider already holds an account for ${email}`,
      );
    if (!response.ok)
      throw new AppError(
        "ERR_INTERNAL",
        `the identity provider refused the ${operation} for ${email} (status ${response.status})`,
      );
    let body: { id?: unknown };
    try {
      body = (await response.json()) as { id?: unknown };
    } catch {
      throw new AppError(
        "ERR_INTERNAL",
        `the identity provider returned an invalid response for ${email}`,
      );
    }
    if (!body || typeof body.id !== "string" || body.id.length === 0)
      throw new AppError("ERR_INTERNAL", `the identity provider returned no subject for ${email}`);
    return { sub: body.id, email };
  }
}

export class StubAuthAdmin implements AuthAdmin {
  createUser(email: string): Promise<InvitedUser> {
    return this.inviteUser(email);
  }
  constructor(private readonly seed = "stub") {}
  inviteUser(email: string): Promise<InvitedUser> {
    const sub = `${this.seed}:${createHash("sha256").update(email.toLowerCase()).digest("hex").slice(0, 32)}`;
    return Promise.resolve({ sub, email });
  }
}

/**
 * Which adapter a serving process gets, and the one case in which it gets none.
 *
 * `StubAuthAdmin` mints `stub:<sha256(email)>` — a subject no Supabase identity ever presents, so
 * `app.resolve_principal` returns no rows for it and the invited person can never sign in. The row is
 * permanent: `auth_subject` is UNIQUE and app_rw holds no DELETE grant on `app.principal`. The seed CLI
 * meets the same missing configuration with a warning and carries on (`packages/db/src/cli.ts:65`,
 * OWNER GATE OD-21), which is right for a command an operator runs by hand and watches. It is not right
 * for an API: the warning scrolls past at boot and every later `POST /v1/admin/users` answers 201,
 * telling an administrator that somebody was invited who was not.
 *
 * `SUPABASE_SERVICE_ROLE_KEY` is withheld from the container on purpose — "the seed CLI's alone"
 * (`apps/edge/src/container-env.ts:5`, §3.11 spec:2273) — so today the first branch is reachable only
 * where that decision is amended. It is written first so that amending it is the whole change.
 */
export function createAuthAdmin(config: ApiConfig): AuthAdmin {
  if (config.supabaseUrl && config.supabaseServiceRoleKey)
    return new SupabaseAuthAdmin({
      url: config.supabaseUrl,
      serviceRoleKey: config.supabaseServiceRoleKey,
      invitePath: INVITE_PATH,
      createPath: CREATE_PATH,
    });
  if (config.appEnv !== "dev") {
    const missing = [
      config.supabaseUrl ? null : "SUPABASE_URL",
      config.supabaseServiceRoleKey ? null : "SUPABASE_SERVICE_ROLE_KEY",
    ].filter((name): name is string => name !== null);
    throw new ConfigError(
      `${missing.join(" and ")} not set — APP_ENV=${config.appEnv} refuses the stub auth admin (OWNER GATE OD-21). It would answer 201 to every invitation while writing a principal nobody can ever sign in as, and one app_rw holds no grant to remove.`,
    );
  }
  return new StubAuthAdmin();
}
