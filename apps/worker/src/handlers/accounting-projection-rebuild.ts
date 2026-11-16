import { isCalendarDate } from "@dulja/domain";
import {
  comparePartyAgeing,
  rebuildItemProfitability,
  rebuildPartyAgeing,
  recordIntegrityIncident,
  withTenant,
  type ProjectionMismatch,
} from "@dulja/db";
import { registerHandler, type JobHandler } from "../handler";
import { log } from "../log";

const NAME = "accounting.projection.rebuild" as const;

export interface AccountingProjectionRebuildDeps {
  /** The per-company rebuild; `rebuildPartyAgeing` unless a test injects a failing one. */
  rebuild?: typeof rebuildPartyAgeing;
  /** 4B Task 4 — the per-company `item_profitability` rebuild; `rebuildItemProfitability` unless a test
   *  injects a failing one. */
  rebuildProfitability?: typeof rebuildItemProfitability;
}

/**
 * `accounting.projection.rebuild` (§4.2.6, scheduled `0 3 * * *`, owner 4B) — the nightly rebuild-and-compare
 * of the ASYNCHRONOUS AR/AP projections spec:1204 names: `party_ageing` (4B Task 3) and `item_profitability`
 * (Task 4), rebuilt in the same per-company transaction. `item_profitability`'s COMPARISON is 1B's
 * `projectionChecks` registry (ADR 0046) and is therefore not repeated here — this handler rebuilds it and the
 * nightly accounting.ledger.integrity_check compares it. It is keyed by fiscal period, not by date, so its log
 * line carries no `as_of`. The twin of 3B's `inventory.projection.rebuild`, and built the same way:
 *
 * - **The tenant fan-out is the scheduler's, not this handler's.** 0D's boot loop installs a `<name>.fanout`
 *   cron that walks `eachTenant` and calls `runJob` once per tenant; `runJob` resolves the tenant's system
 *   principal through `systemContext` (spec:2179, hazard 20) and hands it here as `ctx`. An `eachTenant`
 *   inside the handler would rebuild every tenant once per tenant.
 * - **One company per `withTenant` transaction** (spec:1368): the fan-out inside a tenant is over companies,
 *   and a tenant with two hundred of them must not hold one transaction for the whole run.
 * - **The handler decides nothing.** `rebuildPartyAgeing` MERGEs and zeroes (it never deletes, §3.5.4) and
 *   `comparePartyAgeing` compares the stored snapshot with the fresh rows that rebuild computed and wrote, in
 *   the SAME transaction (one evaluation of the function per company, code review B3), so a mismatch means
 *   the rebuild's own write went wrong — not that a back-dated post legitimately moved a past
 *   as-of figure (ADR 0046). This file writes the log lines and the incident, and that is all it does.
 *
 * A failure on one company does not abandon the rest: it is logged, carried into the one incident the run
 * records, and the next company is attempted. A malformed `asOf` — including a date-shaped string that is not
 * a calendar date — is the caller's fault, not a company's, and fails the job before anything is written.
 */
export function createAccountingProjectionRebuildHandler(
  deps: AccountingProjectionRebuildDeps = {},
): JobHandler<typeof NAME> {
  const rebuild = deps.rebuild ?? rebuildPartyAgeing;
  const rebuildProfitability = deps.rebuildProfitability ?? rebuildItemProfitability;
  return async (sql, job, ctx) => {
    const asOf = job.payload.asOf ?? new Date().toISOString().slice(0, 10);
    // A real calendar date, not merely a date-shaped one: postgres.js would rebuild 2026-02-30, silently, as
    // 2026-03-02, a snapshot for a date nobody asked for. The payload is not a zod schema, so it calls the
    // shared check directly.
    if (!isCalendarDate(asOf)) {
      throw new Error(
        `${NAME}: asOf must be a calendar date YYYY-MM-DD, got ${JSON.stringify(asOf)}`,
      );
    }
    const onlyCompany = job.payload.companyId ?? null;

    const companies = await withTenant(
      sql,
      ctx,
      (tx) => tx<{ id: string }[]>`
        select id::text as id from app.company
         where (${onlyCompany}::uuid is null or id = ${onlyCompany}::uuid)
         order by code`,
    );

    const mismatches: ProjectionMismatch[] = [];
    // The projections this run CHECKED, for the incident (code review B5): party_ageing once its compare has
    // run or its rebuild has thrown, and item_profitability only when its rebuild throws — its comparison is
    // 1B's (ADR 0046), so a thrown rebuild is the one verdict this run gives on it. A Set, in stage order,
    // because withTenant re-runs the callback on a serialisation retry.
    const checked = new Set<"party_ageing" | "item_profitability">();
    for (const company of companies) {
      // Which projection a throw belongs to, so the incident names the one that failed. Set inside the
      // callback because withTenant re-runs it on a serialisation retry.
      const stage: { projection: "party_ageing" | "item_profitability" } = {
        projection: "party_ageing",
      };
      try {
        const { counts, found, profit } = await withTenant(sql, ctx, async (tx) => {
          stage.projection = "party_ageing";
          const ageing = await rebuild(tx, { companyId: company.id, asOf });
          // The compare reads the rows the rebuild just computed and wrote (code review B3), so the
          // function is evaluated once per company, not twice.
          const compared = await comparePartyAgeing(
            tx,
            { companyId: company.id, asOf },
            ageing.rows,
          );
          checked.add("party_ageing");
          stage.projection = "item_profitability";
          return {
            counts: ageing,
            found: compared,
            profit: await rebuildProfitability(tx, { companyId: company.id }),
          };
        });
        mismatches.push(...found);
        // `Logger.info` is `(fields, message)`; `forbidden-log-fields` polices the field names.
        log().info(
          {
            job: NAME,
            tenant_id: ctx.tenantId,
            company_id: company.id,
            as_of: asOf,
            merged: counts.merged,
            zeroed: counts.zeroed,
            mismatches: found.length,
          },
          found.length > 0 ? "party ageing rebuilt with mismatches" : "party ageing rebuilt",
        );
        log().info(
          {
            job: NAME,
            tenant_id: ctx.tenantId,
            company_id: company.id,
            merged: profit.merged,
            zeroed: profit.zeroed,
          },
          "item_profitability rebuilt",
        );
      } catch (error) {
        checked.add(stage.projection);
        log().error(
          {
            job: NAME,
            tenant_id: ctx.tenantId,
            company_id: company.id,
            as_of: asOf,
            projection: stage.projection,
            error: String(error),
          },
          stage.projection === "party_ageing"
            ? "party ageing rebuild failed for one company"
            : "item_profitability rebuild failed for one company",
        );
        mismatches.push({
          projection: stage.projection,
          key:
            stage.projection === "party_ageing"
              ? { company_id: company.id, as_of: asOf }
              : { company_id: company.id },
          side: "amount_differs",
          detail: `rebuild threw: ${String(error)}`,
        });
      }
    }

    if (mismatches.length > 0) {
      // 1B's `recordIntegrityIncident` takes a whole `IntegrityReport` and writes it into the tamper-evident
      // audit chain. This run COMPARED party_ageing (item_profitability's compare is 1B's) and walked no
      // chain, so `projections` carries the real result and every other member is its empty value — 3B's twin
      // does the same. A mismatch naming item_profitability is a rebuild of it that threw, and `checked` then
      // names it too (B5).
      await withTenant(sql, ctx, (tx) =>
        recordIntegrityIncident(tx, {
          tenantId: ctx.tenantId,
          requestId: ctx.requestId,
          checkedAt: new Date().toISOString(),
          ledgerBalance: { byPeriod: [], byDocument: [] },
          projections: { checked: [...checked], mismatches },
          auditChain: { rows: 0, brokenLinks: 0, badHashes: 0, firstBrokenSeq: null },
          periodReopens: [],
          ok: false,
          summary: `FAILED: ${NAME} as at ${asOf} found ${mismatches.length} mismatch(es): ${mismatches.map((m) => m.detail).join("; ")}`,
        }),
      );
    }
  };
}

/**
 * Registered through an exported function, not an import-time side effect: `startWorker()` calls
 * `resetHandlers()` and then re-registers, so a side effect would be cleared and never restored. Called from
 * `apps/worker/src/index.ts` and from the test tier's `startWorker`, exactly as 3B's twin is.
 */
export function registerAccountingProjectionRebuildHandlers(): void {
  registerHandler(NAME, createAccountingProjectionRebuildHandler());
}
