import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { decodeCursor, encodeCursor, UuidSchema } from "@dulja/contracts";
import { LedgerEntryList, LedgerEntryQuery } from "@dulja/contracts/accounting/ledger";
import { PERMISSION } from "@dulja/contracts/permissions";
import { MODULE_ROW_GATES } from "@dulja/db";
import type { Sql } from "postgres";
import type { AppEnv } from "../../context";
import { requirePermission } from "../../middleware/require-permission";

export const ledgerRoutes = new OpenAPIHono<AppEnv>({
  defaultHook: (result) => {
    if (!result.success) throw result.error;
  },
});
const read = requirePermission(PERMISSION["accounting.ledger.read"], {
  company: "path:companyId",
});

const MODULES = Object.keys(MODULE_ROW_GATES).toSorted();
const MODULE_GATES = MODULES.map((module) => MODULE_ROW_GATES[module]!);

/**
 * API-07 (review 2026-11-15; ADR 0090): the ledger rows of a document whose type's module is gated
 * (`MODULE_ROW_GATES` — `hr` → `hr.payroll.read`) need that code at the document's branch, as the generic document
 * routes, the attachment gate and the export already require; `accounting.ledger.read` alone would print a
 * PAYROLL's per-employee net pay. The module is read through the entry's own `posting_policy_id`, which every
 * tenant member can see, so a document the caller cannot see is judged too — at company scope, the stricter
 * answer. Returns the ids among `entryIds` the caller may NOT see.
 */
export async function moduleHiddenEntries(
  tx: Sql,
  entryIds: readonly string[],
): Promise<ReadonlySet<string>> {
  if (entryIds.length === 0) return new Set();
  const rows = await tx<{ id: string }[]>`
    select le.id
      from app.ledger_entry le
      join app.posting_policy pp on pp.id = le.posting_policy_id
      join app.document_type t on t.id = pp.document_type_id
      join unnest(${MODULES}::text[], ${MODULE_GATES}::text[]) as m(module, gate) on m.module = t.module::text
     where le.id = any(${[...entryIds]}::uuid[])
       and not app.actor_has(m.gate, le.company_id,
                             (select d.branch_id from app.document d where d.id = le.document_id))`;
  return new Set(rows.map((row) => row.id));
}

interface Row {
  id: string;
  document_id: string;
  line_no: number;
  account_id: string;
  debit: string;
  credit: string;
  currency: string;
  exchange_rate: string;
  base_debit: string;
  base_credit: string;
  effective_date: string;
  fiscal_period_id: string;
  posting_policy_id: string;
  posted_at: Date;
  posted_by: string;
}

ledgerRoutes.openapi(
  createRoute({
    method: "get",
    path: "/",
    tags: ["accounting"],
    middleware: [read] as const,
    summary: "Read posted ledger entries",
    request: { params: z.object({ companyId: UuidSchema }), query: LedgerEntryQuery },
    responses: {
      200: {
        description: "A page of entries",
        content: { "application/json": { schema: LedgerEntryList } },
      },
    },
  }),
  async (c) => {
    const { companyId } = c.req.valid("param");
    const { cursor, limit, accountId, fiscalPeriodId, documentId, from, to } = c.req.valid("query");
    const after = cursor ? decodeCursor(cursor) : null;
    // Every filter is a declared field bound as a parameter — no field name reaches SQL as text (test 27).
    // The index this uses is 0001's ledger_entry (company_id, account_id, effective_date) — LEGACY-070.
    const rows = await c.var.withTenant(
      (tx) => tx<Row[]>`
      select id, document_id, line_no, account_id, debit::text as debit, credit::text as credit, currency,
             exchange_rate::text as exchange_rate, base_debit::text as base_debit, base_credit::text as base_credit,
             to_char(effective_date, 'YYYY-MM-DD') as effective_date, fiscal_period_id, posting_policy_id,
             posted_at, posted_by
        from app.ledger_entry
       where company_id = ${companyId}
         and (${accountId ?? null}::uuid is null or account_id = ${accountId ?? null}::uuid)
         and (${fiscalPeriodId ?? null}::uuid is null or fiscal_period_id = ${fiscalPeriodId ?? null}::uuid)
         and (${documentId ?? null}::uuid is null or document_id = ${documentId ?? null}::uuid)
         and (${from ?? null}::date is null or effective_date >= ${from ?? null}::date)
         and (${to ?? null}::date is null or effective_date <= ${to ?? null}::date)
         and (${after ? after.id : null}::uuid is null or id > ${after ? after.id : null}::uuid)
         and not exists (
           select 1 from app.posting_policy pp
             join app.document_type t on t.id = pp.document_type_id
             join unnest(${MODULES}::text[], ${MODULE_GATES}::text[]) as m(module, gate)
               on m.module = t.module::text
            where pp.id = ledger_entry.posting_policy_id
              and not app.actor_has(m.gate, ledger_entry.company_id,
                                    (select d.branch_id from app.document d where d.id = ledger_entry.document_id)))
       order by id limit ${limit + 1}`,
    );
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return c.json(
      {
        items: page.map((row) => ({
          id: row.id,
          documentId: row.document_id,
          lineNo: row.line_no,
          accountId: row.account_id,
          debit: row.debit,
          credit: row.credit,
          currency: row.currency,
          exchangeRate: row.exchange_rate,
          baseDebit: row.base_debit,
          baseCredit: row.base_credit,
          effectiveDate: row.effective_date,
          fiscalPeriodId: row.fiscal_period_id,
          postingPolicyId: row.posting_policy_id,
          postedAt: row.posted_at.toISOString(),
          postedBy: row.posted_by,
        })),
        next_cursor: rows.length > limit && last ? encodeCursor({ k: [], id: last.id }) : null,
      },
      200,
    );
  },
);
