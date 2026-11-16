import type { Sql } from "postgres";
import type { TenantContext } from "../with-tenant";
import { PostingError } from "./errors";
import { loadSnapshot, resolvePolicy } from "./load";

export interface IssueResult {
  documentId: string;
  series: string;
  fiscalPeriodId: string;
  number: bigint;
}

/** The transitions from which `→ issued` is reachable at Phase 1. `approval.required = false` on the JOURNAL
 *  policy admits `draft → issued` (contracts §4.5.1, the two rows marked †); 2B moves this table into
 *  app.document_status_before() where it becomes the control rather than a pre-check. */
const ISSUABLE_FROM = new Set(["draft", "submitted", "approved"]);

/**
 * The effective numbering series for a document (contracts §4.3.6, Task 0 amendment 6).
 *
 * `policy.numbering.series` is a static literal by §4.4.1's frozen schema, but §4.14 gives `POS_TICKET` the
 * series `POS-<terminal code>` and spec:1721's own example is `'POS-KL01'`. A per-terminal counter is not
 * cosmetic: without it every till in a company contends for one `document_series` row, and a 200-ticket batch
 * would hold that row's advisory lock for its whole transaction while every other till waited.
 *
 * The branch is unreachable outside Phase 6 — no other slice's documents carry a `terminal_id` — so every
 * existing numbering test is untouched, which is the property that let this be an extension and not an ADR
 * against 1A.
 */
export async function resolveSeries(
  tx: Sql,
  documentId: string,
  policySeries: string,
): Promise<string> {
  const rows = await tx<{ code: string | null }[]>`
    select t.code
      from app.document d
      join app.pos_terminal t on t.id = d.terminal_id
     where d.id = ${documentId}`;
  const code = rows[0]?.code ?? null;
  return code === null ? policySeries : `${policySeries}-${code}`;
}

/**
 * Resolves the fiscal period from `effective_date`, takes the series counter under the advisory lock of
 * spec:1741 and writes `status = 'issued'`, `series`, `fiscal_period_id` and `number` on the document.
 * Takes the caller's `tx` and opens none of its own, so a rollback releases the lock and never consumes a
 * number (spec:1744).
 */
export async function issueDocument(
  tx: Sql,
  ctx: TenantContext,
  input: { documentId: string },
): Promise<IssueResult> {
  // One issuer per document. The status check below is only meaningful if nobody else can pass it at the
  // same time: without this lock two `to: "issued"` transitions on one draft both read 'draft', both take a
  // number under the series lock in turn, and the second overwrites the first — a burned number with no
  // document_number_void row, which is LEGACY-051 reborn. postDocument already holds this same lock (post.ts
  // step 1) when it calls in, and re-locking a row one's own transaction holds is a no-op.
  const [locked] = await tx<{ status: string; document_type_id: string }[]>`
    select status::text as status, document_type_id from app.document
     where id = ${input.documentId} for update`;
  if (!locked) {
    throw new PostingError("ERR_NOT_FOUND", `no document ${input.documentId} in this tenant`);
  }
  const snapshot = await loadSnapshot(tx, input.documentId);
  if (locked.status === "issued") {
    throw new PostingError(
      "ERR_DOC_STATUS_ILLEGAL",
      `document ${input.documentId} is already issued as ${snapshot.header.series} ${snapshot.header.number}`,
    );
  }
  if (!ISSUABLE_FROM.has(locked.status)) {
    throw new PostingError(
      "ERR_DOC_STATUS_ILLEGAL",
      `document ${input.documentId} is ${locked.status} and cannot be issued`,
    );
  }

  // The snapshot carries the type's CODE (the evaluator resolves policies by code); resolvePolicy is keyed by
  // the type's id, which the locked row already carries.
  const { definition } = await resolvePolicy(
    tx,
    locked.document_type_id,
    snapshot.header.effectiveDate,
  );
  const series = await resolveSeries(tx, input.documentId, definition.numbering.series);

  // `for share`: a concurrent close of this period (fiscal-periods.ts) takes a row lock on it and therefore
  // waits for this issue to commit or roll back, instead of committing between this check and our commit.
  const [period] = await tx<{ id: string; status: string }[]>`
    select id, status::text as status from app.fiscal_period
     where company_id = ${snapshot.header.companyId}
       and ${snapshot.header.effectiveDate}::date between starts_on and ends_on
     for share`;
  if (!period) {
    throw new PostingError(
      "ERR_PERIOD_NOT_FOUND",
      `no fiscal period of company ${snapshot.header.companyId} contains ${snapshot.header.effectiveDate}`,
    );
  }
  if (period.status !== "open") {
    throw new PostingError("ERR_PERIOD_NOT_OPEN", `fiscal period ${period.id} is ${period.status}`);
  }

  // contracts §4.3.6, verbatim. The key is spec:1741's; it is deliberately NOT the audit chain's
  // 'tenant-serial:<tenant>' key, so the two locks can never deadlock with each other (plan0A:2280-2284).
  await tx`select pg_advisory_xact_lock(hashtextextended('series:' || ${snapshot.header.companyId}::text || '/' || ${series} || '/' || ${period.id}::text, 0))`;
  // The counter row is created on first use — this is the "first document of a new series in a new period"
  // half of acceptance test 16, and the reason both racers succeed instead of one hitting a missing row.
  await tx`insert into app.document_series (tenant_id, company_id, series, fiscal_period_id)
           values (${ctx.tenantId}, ${snapshot.header.companyId}, ${series}, ${period.id})
           on conflict do nothing`;
  const [counter] = await tx<{ number: string }[]>`
    update app.document_series set next_number = next_number + 1
     where company_id = ${snapshot.header.companyId} and series = ${series} and fiscal_period_id = ${period.id}
     returning (next_number - 1)::text as number`;
  const number = BigInt(counter!.number);

  await tx`update app.document
              set status = 'issued', series = ${series}, fiscal_period_id = ${period.id}, number = ${number.toString()}::bigint
            where id = ${input.documentId}`;

  return { documentId: input.documentId, series, fiscalPeriodId: period.id, number };
}
