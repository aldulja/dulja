import type { Money, Quantity } from "@dulja/domain";
import type { LegacyRow } from "../legacy/types";
import { baseCurrency } from "./run";
import { dateOf, moneyOf, optionalText, requireText } from "./scalar";
import { LoadError, type Loader, type SourceColumn } from "./types";

/** One historical till ticket, in the shape a 6A `TicketBatch` ticket is built from. `lines` stay empty until the
 *  `POSENTRIES` mapping exists (see `mposLoader`). */
export interface HistoricalTicket {
  legacyKey: string;
  ticketNumber: string;
  soldAt: string;
  terminalCode: string;
  cashierRef: string | null;
  lines: { itemKey: string; quantity: Quantity; unitPrice: Money }[];
  tenders: { method: TenderMethod; amount: Money }[];
}

/** 6A's four tender methods (`TenderMethodSchema`, `packages/contracts/src/sync/ticket.ts`; §4.6.5), repeated here
 *  because the importer may not import `@dulja/contracts` (§3.1). */
const TENDER_METHODS = ["cash", "card", "transfer", "store_credit"] as const;
type TenderMethod = (typeof TENDER_METHODS)[number];

/** The two `mpos` tables a historical ticket reads (Part VII #10; the separate POS database 9A scopes with
 *  `--mpos-dsn`). */
export const MPOS_SOURCE_TABLES: readonly string[] = ["POSTICKETS", "POSENTRIES"];

const COLUMNS: readonly SourceColumn[] = [
  {
    name: "PTKID",
    required: true,
    confidence: "hypothesis",
    note: "the ticket's own key (posTickets, prefix PTK)",
  },
  {
    name: "PTKNUMBER",
    required: true,
    confidence: "hypothesis",
    note: "the printed ticket number → document.legacy_ref",
  },
  {
    name: "PTKDATE",
    required: true,
    confidence: "hypothesis",
    note: "the sale date; a historical ticket keeps its OWN date, not the cut-over date",
  },
  {
    name: "PTKTERMINAL",
    required: true,
    confidence: "hypothesis",
    note: "the till's code; must match an enrolled pos_terminal (6A)",
  },
  {
    name: "PTKCASHIER",
    required: false,
    confidence: "hypothesis",
    note: "the cashier's Employees key → document.attributed_to (hazard 19)",
  },
  {
    name: "PTKTOTAL",
    required: true,
    confidence: "hypothesis",
    note: "ticket total, used to check the sum of the lines",
  },
  {
    name: "PTKTENDER",
    required: true,
    confidence: "hypothesis",
    note: "tender method: cash | card | transfer | store_credit (§4.6.5)",
  },
];

const isTender = (value: string): value is TenderMethod =>
  (TENDER_METHODS as readonly string[]).includes(value);

/**
 * ⚠️ **OD-16 (Part VII #10) — written, NOT registered.** §2.12's default is "start clean": the new POS begins at
 * cut-over with only the catalogue. This loader is exported and unit-tested against `test/corpus/mpos-history` and is
 * absent from `loaders` (`registry.ts`), so no run, CLI `--only` or `admin.import.run` job can reach it. If the owner
 * confirms the default, this file, its test and that corpus are deleted and nothing else changes.
 *
 * **If it is ever enabled it builds a 6A `TicketBatch` and hands it to `applyBatch`; it never drafts a document
 * itself.** A POS ticket has one posting path (acceptance test 22): `applyBatch(tx, ctx, terminal, batch)`
 * (`packages/db/src/sync/apply.ts`), where the terminal is the acting principal and the cashier is attributed
 * (hazard 19). A batch carries its `shifts` (`TicketBatch.shifts`, `packages/sync/src/messages.ts`) and every ticket
 * must belong to a shift 6D knows — `applyShiftOpen`/`applyShiftClose`/`assertShiftKnown`
 * (`packages/db/src/sync/shifts.ts`) over `app.shift` (migration 0070), read back by `zReport`
 * (`packages/db/src/reports/pos.ts`) — which is why a "yes" needs 6D executed first (§6.3). A historical ticket that
 * bypassed `applyBatch` would be a second POS posting path, so `draftAndPost` is deliberately not used here, and none
 * of those names is imported while `load` is a refusal: an import nothing calls fails `noUnusedLocals`, and naming
 * them here is the whole record the unanswered gate needs.
 *
 * The `load` body refuses rather than guessing: the `POSENTRIES` line mapping, the terminal enrolment of a till that
 * no longer exists and the shift a historical ticket belongs to are three designs against a decision that is more
 * likely to be "no" — each the invention hazards 3 and 6 forbid.
 */
export const mposLoader: Loader<LegacyRow, HistoricalTicket> = {
  sourceTable: "POSTICKETS",
  targetTable: "pos_ticket",
  dependsOn: ["item", "warehouse", "party", "employee"],
  sourceColumns: COLUMNS,
  sourceKey: (row) => requireText(row, "PTKID", "POSTICKETS"),

  map(row) {
    const legacyKey = requireText(row, "PTKID", "POSTICKETS");
    const site = `POSTICKETS/${legacyKey}`;
    const ticketNumber = requireText(row, "PTKNUMBER", site);
    const terminalCode = optionalText(row, "PTKTERMINAL");
    if (terminalCode === null || terminalCode.trim() === "") {
      return {
        skip: `ticket ${ticketNumber} names no terminal; a POS_TICKET must be attributed to an enrolled terminal (spec:1324)`,
      };
    }
    const method = requireText(row, "PTKTENDER", site);
    if (!isTender(method)) {
      return {
        skip: `ticket ${ticketNumber} has tender method ${JSON.stringify(method)}, which is not one of the four §4.6.5 methods`,
      };
    }
    return {
      legacyKey,
      ticketNumber,
      soldAt: dateOf(row, "PTKDATE", site),
      terminalCode,
      cashierRef: optionalText(row, "PTKCASHIER"),
      // Filled from POSENTRIES once OD-16 is answered yes and the line mapping is read from a live catalogue.
      lines: [],
      tenders: [{ method, amount: moneyOf(row, "PTKTOTAL", baseCurrency(), site) }],
    };
  },

  async load(_tx, _ctx, rows) {
    throw new LoadError(
      "ERR_VALIDATION_FAILED",
      `the historical POS loader is not enabled: OD-16 (Part VII #10) has not been answered, so the default "start clean" stands and ${rows.length} ticket(s) were not loaded. Answering yes means registering mposLoader in registry.ts, executing 6D first (§6.3), and completing this body against applyBatch (§4.10.4)`,
    );
  },
};
