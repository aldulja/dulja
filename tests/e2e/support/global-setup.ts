import { bootLocalStack } from "./boot";

export default async function globalSetup(): Promise<void> {
  // Pointed at staging (OD-20/OD-21), nothing local is started — the same specs run against the
  // real thing, signed in as a real Supabase account, and this harness gets out of the way.
  if (process.env["PLAYWRIGHT_BASE_URL"]) return;
  globalThis.duljaStack = await bootLocalStack();
}
