import { createHash } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { SeedConfigError, type SeedConfig } from "./config";

/**
 * The seed's own, narrower auth port. 0B declares `AuthAdmin` in `apps/api/src/ports.ts`; packages never import
 * apps (§3.1), so this is a contract addition, recorded in plan 0C's Self-Review.
 *
 * Verified against @supabase/supabase-js 2.116.0 (@supabase/auth-js 2.116.0) in Task 9 Step 1: the admin API is
 * `client.auth.admin`, a user is created with `createUser({ email, email_confirm })`, users are listed with
 * `listUsers({ page, perPage })`, and the subject is `user.id`. The installed version has no find-by-e-mail
 * method, so `findByEmail` pages through `listUsers` and filters. No REST path is written anywhere here.
 */
export interface SeedAuthUser {
  readonly sub: string;
  readonly email: string;
}

export interface SeedAuthAdmin {
  /** Returns the existing user or null. Called BEFORE createUser so a second run never makes a second owner. */
  findByEmail(email: string): Promise<SeedAuthUser | null>;
  createUser(email: string): Promise<SeedAuthUser>;
}

const PAGE_SIZE = 200;
const MAX_PAGES = 20;

export class SupabaseSeedAuthAdmin implements SeedAuthAdmin {
  readonly #client: SupabaseClient;

  constructor(url: string, serviceRoleKey: string) {
    // The service-role key exists in the seed CLI and nowhere else (§3.11, spec:2273).
    this.#client = createClient(url, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }

  async findByEmail(email: string): Promise<SeedAuthUser | null> {
    const wanted = email.toLowerCase();
    for (let page = 1; page <= MAX_PAGES; page++) {
      const { data, error } = await this.#client.auth.admin.listUsers({ page, perPage: PAGE_SIZE });
      if (error) throw error;
      const hit = data.users.find((user) => (user.email ?? "").toLowerCase() === wanted);
      if (hit) return { sub: hit.id, email: hit.email ?? email };
      if (data.users.length < PAGE_SIZE) return null;
    }
    throw new Error(
      `more than ${MAX_PAGES * PAGE_SIZE} Supabase users; refusing to guess whether ${email} exists`,
    );
  }

  async createUser(email: string): Promise<SeedAuthUser> {
    // No password: the owner sets one through Supabase's own recovery flow. The application never stores or
    // compares a password (spec:2131, SAH-028), and MFA is enrolled at first login (spec:2004).
    const { data, error } = await this.#client.auth.admin.createUser({
      email,
      email_confirm: true,
    });
    if (error) throw error;
    return { sub: data.user.id, email: data.user.email ?? email };
  }
}

/**
 * OD-21's local equivalent. A deterministic subject per e-mail, so a re-run in a test finds the same user.
 * `node:crypto` rather than `Bun.hash`: the CLI runs under Bun and Vitest under Node 24 (D5), and the stub has to
 * work under both. The `stub-` prefix keeps it obviously not a Supabase `sub` in any dump.
 */
export class StubSeedAuthAdmin implements SeedAuthAdmin {
  readonly #users = new Map<string, SeedAuthUser>();
  createdCount = 0;

  async findByEmail(email: string): Promise<SeedAuthUser | null> {
    return this.#users.get(email.toLowerCase()) ?? null;
  }

  async createUser(email: string): Promise<SeedAuthUser> {
    const key = email.toLowerCase();
    const user: SeedAuthUser = {
      sub: `stub-${createHash("sha256").update(key).digest("hex").slice(0, 32)}`,
      email,
    };
    this.#users.set(key, user);
    this.createdCount++;
    return user;
  }
}

/**
 * The CLI's choice of auth admin. Supabase when `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are both set; the
 * stub otherwise, but only in `dev` or for an `--only` run, which never reaches the owner step (DBS-17, 2026-11-15
 * full review: a production seed without them created an owner whose subject was `stub-…`, who could never log
 * in, and exited 0). Throws `SeedConfigError`, which the CLI maps to exit 2.
 */
export function seedAuthAdminFor(config: SeedConfig, env: NodeJS.ProcessEnv): SeedAuthAdmin {
  const key = env["SUPABASE_SERVICE_ROLE_KEY"];
  const url = env["SUPABASE_URL"];
  if (key && url) return new SupabaseSeedAuthAdmin(url, key);
  if (config.appEnv !== "dev" && config.only === null)
    throw new SeedConfigError(
      `APP_ENV=${config.appEnv} needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY — the stub auth admin is for dev only (OWNER GATE OD-21)`,
    );
  return new StubSeedAuthAdmin();
}
