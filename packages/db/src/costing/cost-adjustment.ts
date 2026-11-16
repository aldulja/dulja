import type { Sql } from "postgres";
import { PostingError } from "../posting/errors";

/** §4.14's one 3B row: accounting / internal / none / series CA / accounting.journal.post. */
export const COST_ADJUSTMENT_CODE = "COST_ADJUSTMENT";

/**
 * The two §4.15 codes the replay posts to. **Seeded by 0C** in `packages/db/seed/my/chart-of-accounts/0c-base.json`
 * and only resolved here — hazard 33 forbids a consuming slice from re-seeding or falling back to null.
 * They are the COMPANY-WIDE fallback: an item with its own control accounts sets
 * `item.inventory_account_id` / `cogs_account_id`, and the replay aggregates across items (§4.7.3).
 */
export const ADJUSTMENT_ACCOUNT_CODES = { inventory: "1300", cogs: "5000" } as const;

export interface AdjustmentAccounts {
  inventoryAccountId: string;
  cogsAccountId: string;
  documentTypeId: string;
}

const LABEL: Record<string, string> = {
  "1300": "inventory control",
  "5000": "cost of goods sold",
};

/**
 * Resolves both account codes and the `COST_ADJUSTMENT` document type for one company, or raises
 * `ERR_NOT_FOUND` naming exactly what is missing. Called ONCE per replay run, before any arithmetic, so a
 * company whose chart or seed pack is incomplete fails at the top of the job with a message an operator can
 * act on — rather than at the insert, halfway through a batch, with a null FK.
 */
export async function resolveAdjustmentAccounts(
  tx: Sql,
  companyId: string,
): Promise<AdjustmentAccounts> {
  const [row] = await tx<
    { inventory_id: string | null; cogs_id: string | null; type_id: string | null }[]
  >`
    select (select id::text from app.account
             where company_id = ${companyId} and code = ${ADJUSTMENT_ACCOUNT_CODES.inventory}
               and archived_at is null)                                                        as inventory_id,
           (select id::text from app.account
             where company_id = ${companyId} and code = ${ADJUSTMENT_ACCOUNT_CODES.cogs}
               and archived_at is null)                                                        as cogs_id,
           -- company_id on this subquery is NOT optional: app.document_type carries company_id uuid not null
           -- and unique (company_id, code) (spec:1694-1703), so in a tenant with two companies an unfiltered
           -- lookup is a non-deterministic single row or a 21000. The id is written onto app.document, whose FK
           -- is (tenant_id, document_type_id) and checks no company — so the wrong one would post silently.
           (select id::text from app.document_type
             where company_id = ${companyId} and code = ${COST_ADJUSTMENT_CODE}
               and archived_at is null)                                                        as type_id`;

  for (const code of [ADJUSTMENT_ACCOUNT_CODES.inventory, ADJUSTMENT_ACCOUNT_CODES.cogs]) {
    const id = code === ADJUSTMENT_ACCOUNT_CODES.inventory ? row?.inventory_id : row?.cogs_id;
    if (!id) {
      throw new PostingError(
        "ERR_NOT_FOUND",
        `company ${companyId} has no account code ${code} (${LABEL[code]}) — apply the 0C chart with \`bun run seed --tenant <id> --only chart-of-accounts\` before a cost replay can post an adjustment`,
      );
    }
  }
  if (!row?.type_id) {
    throw new PostingError(
      "ERR_NOT_FOUND",
      `document type ${COST_ADJUSTMENT_CODE} is not seeded — apply \`bun run seed --tenant <id> --only document-types\``,
    );
  }
  return {
    inventoryAccountId: row.inventory_id!,
    cogsAccountId: row.cogs_id!,
    documentTypeId: row.type_id,
  };
}
