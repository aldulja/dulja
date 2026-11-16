export type AppEnv = "dev" | "staging" | "production";

const APP_ENVS: readonly AppEnv[] = ["dev", "staging", "production"];

export class AppEnvError extends Error {}

/**
 * APP_ENV, read as `apps/api/src/config.ts`'s `readConfig` reads it: unset is `"dev"`, and anything
 * outside the three names is refused rather than guessed. The value decides whether the synthetic
 * transmitter — which manufactures acceptances — is registered (ADR 0052 decision 6), so a misspelt
 * `"prod"` must stop the worker, not boot it as `dev`. The rule is reproduced rather than shared:
 * `apps/worker` and `apps/api` are sibling apps, and §3.1's dependency rule forbids one importing the
 * other. `index.ts` writes the refusal to stderr and exits 2 before registering anything.
 */
export function parseAppEnv(env: NodeJS.ProcessEnv = process.env): AppEnv {
  const appEnv = env["APP_ENV"] ?? "dev";
  if (!(APP_ENVS as readonly string[]).includes(appEnv))
    throw new AppEnvError(
      `invalid APP_ENV ${JSON.stringify(appEnv)} — expected dev, staging or production`,
    );
  return appEnv as AppEnv;
}
