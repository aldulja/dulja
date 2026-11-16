import { MemoryObjectStore, R2ObjectStore, type ObjectStore } from "@dulja/db";
import type { ApiConfig } from "./config";

/**
 * `dev` without R2 credentials gets an in-process store so `bun run dev` works on a laptop; every other
 * environment gets R2. `readConfig` has already refused to start a staging or production process without
 * the four values, so the narrowing below cannot be reached with a null there.
 */
export function objectStoreFromConfig(config: ApiConfig): ObjectStore {
  if (
    !config.r2AccountId ||
    !config.r2AttachmentsBucket ||
    !config.r2AccessKeyId ||
    !config.r2SecretAccessKey
  ) {
    return new MemoryObjectStore();
  }
  return new R2ObjectStore({
    accountId: config.r2AccountId,
    bucket: config.r2AttachmentsBucket,
    accessKeyId: config.r2AccessKeyId,
    secretAccessKey: config.r2SecretAccessKey,
  });
}
