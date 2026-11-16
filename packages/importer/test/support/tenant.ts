import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHrKeyRing, systemContext } from "@dulja/db";
import { seedAccount, seedDocumentType, seedTenantV2, type Db, type Seed } from "@dulja/db/test";
import type { LoadContext } from "../../src/load/types";

/**
 * 9B plan N16 — the test-tier twin of the cut-over runbook's step 2 (`bun run seed --only chart-of-accounts
 * --only document-types`). `seedTenantV2` is `seedTenant` (`1000`, `4000`) plus `5920` and the JOURNAL policy, and no
 * loader from Task 4 on can run against that: each fails closed on a missing §4.15 account or a missing cut-over
 * document type, which is right in production and the wrong setup for a test. Internal to `packages/importer/test/**`;
 * `tests/invariants/support/cut-over.ts` repeats the two short lists inline because `tests/` may not import this
 * directory (§3.1).
 *
 * The codes, names and types are §4.15's verbatim — a test tenant whose `1300` were typed `expense` would prove
 * nothing about the real one.
 */
const ACCOUNTS: readonly {
  code: string;
  nameEn: string;
  type: "asset" | "liability" | "equity" | "income" | "expense";
}[] = [
  { code: "1200", nameEn: "Trade receivables (AR control)", type: "asset" },
  { code: "1300", nameEn: "Inventory control", type: "asset" },
  { code: "2100", nameEn: "Trade payables (AP control)", type: "liability" },
  { code: "3900", nameEn: "Opening-balance suspense", type: "equity" },
  { code: "5000", nameEn: "Cost of goods sold", type: "expense" },
  { code: "5900", nameEn: "Other operating expense", type: "expense" },
];

/** `packages/importer/test/support/` → three levels up is `packages/`. `fileURLToPath`, never `.pathname`: on Windows
 *  `new URL(…).pathname` yields `/C:/…`, which `readFileSync` rejects. */
const TYPE_DIR = fileURLToPath(new URL("../../../db/seed/my/document-types/", import.meta.url));

/** The two cut-over document types (§4.14 `OB`/`OS`). Tasks 5 and 6 write their seed files; until then a missing
 *  file is passed over, because no registered loader needs it yet. */
const CUT_OVER_TYPES = ["OPENING_BALANCE.json", "OPENING_STOCK.json"] as const;

interface Envelope {
  readonly code: string;
  readonly module: "accounting" | "inventory" | "hr" | "pos";
  readonly policyVersion: number;
  readonly effectiveFrom: string;
  readonly policy: unknown;
}

/**
 * A tenant a 9B load can run against: `seedTenantV2` plus the six §4.15 accounts above and both cut-over document
 * types, each read from **the slice's own seed file** rather than re-typed — a re-typed policy would make every posting
 * test green against a policy nobody deploys. 0A's three fiscal periods are left alone (2026-01 open, 2026-02 closed,
 * 2026-03 locked): the cut-over date `2026-01-31` posts, and Task 5's closed-period case depends on 2026-02.
 */
export async function seedLoadableTenant(db: Db, name: string): Promise<Seed> {
  const s = await seedTenantV2(db, name);
  for (const account of ACCOUNTS) await seedAccount(db, s, account);
  for (const file of CUT_OVER_TYPES) {
    const path = `${TYPE_DIR}${file}`;
    if (!existsSync(path)) continue;
    const envelope = JSON.parse(readFileSync(path, "utf8")) as Envelope;
    await seedDocumentType(db, s, {
      code: envelope.code,
      module: envelope.module,
      policy: envelope.policy,
      policyVersion: envelope.policyVersion,
      effectiveFrom: envelope.effectiveFrom,
    });
  }
  return s;
}

/** The `LoadContext` every importer test builds: the tenant's SYSTEM principal (spec:2179), this company, the
 *  cut-over date the committed corpus is written for, and whatever the case overrides. */
export async function loadContextFor(
  db: Db,
  s: Seed,
  runId: string,
  over: Partial<LoadContext> = {},
): Promise<LoadContext> {
  return {
    ...(await systemContext(db.rw, s.tenant, runId)),
    companyId: s.company,
    runId,
    cutOverDate: "2026-01-31",
    dryRun: false,
    ...over,
  };
}

/** The HR key ring every importer suite seals under (9B T8): a deterministic test key, never 8A's `DEV_HR_KEY`, so no
 *  suite depends on `APP_ENV === "dev"`. A whole-registry load includes the employee loader, which refuses to run
 *  without a ring (`setKeyRing`). */
export const TEST_KEY_RING = createHrKeyRing({
  current: Buffer.alloc(32, 7).toString("base64"),
  currentVersion: 1,
});
