/** packages/db's own configuration error (8A amendment A21 item 9). `packages/db` may not import `apps/api`'s
 *  `ConfigError` (§3.1), so the HR key ring throws this one; `apps/api/src/config.ts` validates the key with its
 *  own class first, so a deployment's bad key exits 2 at boot before this one could be reached. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}
