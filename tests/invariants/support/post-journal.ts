import { postDocument, withTenant, type TenantContext } from "@dulja/db";
import { draftDocument, grantCodes, uuidv7, type Db, type Seed } from "@dulja/db/test";

/** Seeds that have already been granted accounting.journal.post — the helper is called many times per Seed. */
const granted = new WeakSet<Seed>();

/** Slice 2B: the BEFORE UPDATE OF status trigger calls app.actor_has(policy.approval.post, …) on issued →
 *  posted, and `seedTenant` grants `s.human` nothing (contracts §4.1). One grant per Seed, memoised. */
async function ensurePostAuthority(db: Db, s: Seed): Promise<void> {
  if (granted.has(s)) return;
  await grantCodes(db, s, { codes: ["accounting.journal.post"], roleCode: "post-journal" });
  granted.add(s);
}

export interface JournalLine {
  /** app.account id. */
  account: string;
  /** Fixed 4 dp, document currency. Exactly one of debit/credit is non-zero. */
  debit?: string;
  credit?: string;
  /**
   * 8B, contracts round 17 amendment A13. Dimension-type CODE → `dimension_value.id`, the exact shape of
   * `document_line.dimensions` (§4.3.4). Omitted, the column takes its `'{}'::jsonb` default and every pre-8B
   * caller behaves exactly as before. JOURNAL_POLICY_V1 declares no `dimensions` block, so 2A's evaluator reads
   * this bag by default and the header's BRANCH then wins over the bag's (LEGACY-042/LEGACY-050).
   */
  dimensions?: Record<string, string>;
}

export interface PostJournalOptions {
  /** Defaults to the fixture's open period, 2026-01-15. */
  effectiveDate?: string;
  periodId?: string;
  /** Defaults to the document currency 'MYR' at rate 1. */
  currency?: string;
  rate?: string;
  /** Defaults to s.human. A job-path test passes s.system. */
  actorId?: string;
}

/**
 * Drafts a JOURNAL with its document_line rows and posts it through the real posting service
 * (§4.3.1 postDocument). Every invariant suite in this slice uses this and never writes ledger_entry
 * itself, so the tests exercise the same path production does (spec:98).
 *
 * It lives in the test tier, not in packages/db/test/fixtures.ts: contracts §4.17 assigns slice 1B no
 * fixtures.ts helper, and hazard 9 forbids inventing one beside the register.
 */
export async function postJournal(
  db: Db,
  seed: Seed,
  lines: JournalLine[],
  opts: PostJournalOptions = {},
): Promise<{ documentId: string; number: bigint }> {
  await ensurePostAuthority(db, seed);
  const ctx: TenantContext = {
    tenantId: seed.tenant,
    actorId: opts.actorId ?? seed.human,
    requestId: await uuidv7(db.admin),
  };
  const documentId = await draftDocument(db, seed, {
    effectiveDate: opts.effectiveDate ?? "2026-01-15",
    periodId: opts.periodId ?? seed.period,
  });
  return withTenant(db.rw, ctx, async (tx) => {
    if (opts.currency !== undefined || opts.rate !== undefined) {
      await tx`update app.document set currency = ${opts.currency ?? "MYR"}, exchange_rate = ${opts.rate ?? "1"}
                where id = ${documentId}`;
    }
    let lineNo = 0;
    for (const line of lines) {
      lineNo += 1;
      await tx`insert into app.document_line (tenant_id, company_id, document_id, line_no, account_id, debit, credit,
                                              dimensions)
               values (${seed.tenant}, ${seed.company}, ${documentId}, ${lineNo}, ${line.account},
                       ${line.debit ?? "0"}, ${line.credit ?? "0"},
                       ${JSON.stringify(line.dimensions ?? {})}::text::jsonb)`;
    }
    const result = await postDocument(tx, ctx, { documentId });
    return { documentId, number: result.number };
  });
}
