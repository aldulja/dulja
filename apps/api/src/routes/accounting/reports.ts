import { staffBranchGate } from "../staff-permission";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import {
  AGEING_FILTER_FIELDS,
  AgeingList,
  AgeingQuery,
  AppError,
  CurrencySchema,
  DateSchema,
  decodeCursor,
  encodeCursor,
  LedgerList,
  LedgerQuery,
  ProblemSchema,
  SalesByItemList,
  SalesByItemQuery,
  StockOnHandReportList,
  StockOnHandReportQuery,
  TrialBalanceList,
  TrialBalanceQuery,
  PartyKindSchema,
  parseFilters,
  UuidSchema,
  ValuationList,
  ValuationQuery,
} from "@dulja/contracts";
import { PERMISSION } from "@dulja/contracts/permissions";
import {
  accountLedger,
  accountOpeningBalance,
  agedBalance,
  PARTY_AGEING_BUCKETS,
  salesByItem,
  stockOnHand,
  trialBalance,
  valuationAsOf,
  type AgedBalanceParams,
  type AgeingBucket,
} from "@dulja/db";
import type { AppEnv } from "../../context";
import type { RouteModule } from "../index";
import { IdempotencyHeader } from "../idempotency-header";
import { CreateReportRunBody, ReportRunAcceptedSchema } from "@dulja/contracts";
import { assertDatasetGate, createReportRun, REPORT_RUN_JOB_OPTIONS } from "@dulja/db";
import { REPORT_CODE_PATTERN } from "@dulja/domain";
import {
  assertParameters,
  assertSavedViewForRun,
  reportExportRequestGate,
  requireReportRead,
  resolveDefinitionForRun,
} from "../../reports/authorise";
import { requirePermission } from "../../middleware/require-permission";
import { moduleHiddenEntries } from "./ledger";
import { INVENTORY_PERMISSION } from "../inventory/permissions";

// The cursor codec is `@dulja/contracts`' single implementation (§4.2.8: "one implementation, in `common.ts`,
// imported by every list handler in every slice" — a second base64url round-trip here would be hazard 9).
// `decodeCursor` returns the registered `Cursor` (`{ k: unknown[]; id: string }`) and itself throws
// AppError("ERR_VALIDATION_FAILED") on anything that is not that shape, so each handler below only has to
// check that the decoded `k` matches *its own* keyset. 7A reuses the same codec when it adds
// POST /v1/companies/{companyId}/reports/{code}/runs to this same router.

const CompanyParams = z.object({ companyId: z.string().uuid() });
const CURRENCY = /^[A-Z]{3}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const POSTING_SEQ = /^\d{1,19}$/;

/**
 * The currency every base amount on the wire is stamped with. Never defaulted: a company the caller cannot
 * see is ERR_NOT_FOUND, not a report priced in a currency the API made up — and the base currency is
 * OD-21's to name, so no literal belongs here.
 */
async function companyBaseCurrency(
  tx: Parameters<Parameters<AppEnv["Variables"]["withTenant"]>[0]>[0],
  companyId: string,
): Promise<string> {
  const [company] = await tx<{ base_currency: string }[]>`
    select base_currency from app.company where id = ${companyId}`;
  if (!company) throw new AppError("ERR_NOT_FOUND", `no company ${companyId} in this tenant`);
  return company.base_currency.trim();
}

export const reportsRoutes = new OpenAPIHono<AppEnv>({
  defaultHook: (result) => {
    if (!result.success) throw result.error;
  },
});

const trialBalanceRoute = createRoute({
  method: "get",
  path: "/accounting.trial_balance",
  tags: ["accounting"],
  summary: "Trial balance for one fiscal period (report code accounting.trial_balance)",
  middleware: [
    requirePermission(PERMISSION["accounting.report.read"], { company: "path:companyId" }),
  ] as const,
  request: { params: CompanyParams, query: TrialBalanceQuery },
  responses: {
    200: {
      description: "Trial balance rows",
      content: { "application/json": { schema: TrialBalanceList } },
    },
    400: {
      description: "Invalid query",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
    403: {
      description: "Forbidden",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
  },
});

reportsRoutes.openapi(trialBalanceRoute, async (c) => {
  const { companyId } = c.req.valid("param");
  const query = c.req.valid("query");

  let cursor: { accountCode: string; currency: string } | null = null;
  if (query.cursor !== undefined) {
    const decoded = decodeCursor(query.cursor);
    if (
      decoded.k.length !== 2 ||
      typeof decoded.k[0] !== "string" ||
      decoded.k[0] === "" ||
      typeof decoded.k[1] !== "string" ||
      !CURRENCY.test(decoded.k[1])
    ) {
      throw new AppError(
        "ERR_VALIDATION_FAILED",
        "cursor is not a valid keyset cursor for accounting.trial_balance",
      );
    }
    cursor = { accountCode: decoded.k[0], currency: decoded.k[1] };
  }

  const { rows, baseCurrency } = await c.var.withTenant(async (tx) => {
    const base = await companyBaseCurrency(tx, companyId);
    const found = await trialBalance(tx, {
      companyId,
      fiscalPeriodId: query.fiscalPeriodId,
      currency: query.currency,
      cursor,
      limit: query.limit,
    });
    return { rows: found, baseCurrency: base };
  });

  const last = rows.at(-1);
  return c.json(
    {
      items: rows.map((row) => ({
        accountId: row.accountId,
        accountCode: row.accountCode,
        accountNameEn: row.accountNameEn,
        accountNameAr: row.accountNameAr,
        accountType: row.accountType,
        currency: row.currency,
        debit: { amount: row.debit, currency: row.currency },
        credit: { amount: row.credit, currency: row.currency },
        baseDebit: { amount: row.baseDebit, currency: baseCurrency },
        baseCredit: { amount: row.baseCredit, currency: baseCurrency },
      })),
      next_cursor:
        rows.length === query.limit && last !== undefined
          ? encodeCursor({ k: [last.accountCode, last.currency], id: last.accountId })
          : null,
    },
    200,
  );
});

const ledgerRoute = createRoute({
  method: "get",
  path: "/accounting.ledger",
  tags: ["accounting"],
  summary: "One account's ledger over a date range (report code accounting.ledger)",
  middleware: [
    requirePermission(PERMISSION["accounting.report.read"], { company: "path:companyId" }),
    requirePermission(PERMISSION["accounting.ledger.read"], { company: "path:companyId" }),
  ] as const,
  request: { params: CompanyParams, query: LedgerQuery },
  responses: {
    200: {
      description: "Ledger rows with a running base balance",
      content: { "application/json": { schema: LedgerList } },
    },
    400: {
      description: "Invalid query",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
    403: {
      description: "Forbidden",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
  },
});

reportsRoutes.openapi(ledgerRoute, async (c) => {
  const { companyId } = c.req.valid("param");
  const query = c.req.valid("query");

  // The cursor is the chronological KEY and nothing else. It used to carry the running balance too, as the
  // seed for the next page's window sum — a money figure read back from an unsigned client value, and one a
  // malformed cursor turned into a 500 at `::numeric`. accountLedger now recomputes the seed from the ledger.
  let cursor: { effectiveDate: string; postingSeq: string; lineNo: number } | null = null;
  if (query.cursor !== undefined) {
    const decoded = decodeCursor(query.cursor);
    const [date, seq, line] = decoded.k;
    if (
      decoded.k.length !== 3 ||
      typeof date !== "string" ||
      !ISO_DATE.test(date) ||
      typeof seq !== "string" ||
      !POSTING_SEQ.test(seq) ||
      typeof line !== "number" ||
      !Number.isInteger(line) ||
      line < 1
    ) {
      throw new AppError(
        "ERR_VALIDATION_FAILED",
        "cursor is not a valid keyset cursor for accounting.ledger",
      );
    }
    cursor = { effectiveDate: date, postingSeq: seq, lineNo: line };
  }

  const { rows, hidden, opening, baseCurrency } = await c.var.withTenant(async (tx) => {
    const base = await companyBaseCurrency(tx, companyId);
    // `opening_base_balance` is the balance BROUGHT FORWARD into `fromDate`, and it is the same number on
    // every page of the same range — a client that prints "Opening balance" per page must not see it
    // change under it. It is therefore computed from `fromDate` unconditionally.
    const openingBalance = await accountOpeningBalance(tx, {
      companyId,
      accountId: query.accountId,
      beforeDate: query.fromDate,
    });
    const found = await accountLedger(tx, {
      companyId,
      accountId: query.accountId,
      fromDate: query.fromDate,
      toDate: query.toDate,
      cursor,
      limit: query.limit,
    });
    // API-07: a gated module's lines (a PAYROLL's per-employee nets) are left out of the page, never re-summed —
    // every row shown keeps the ledger's own running balance, and the cursor stays on the last row READ.
    const gated = await moduleHiddenEntries(
      tx,
      found.map((row) => row.entryId),
    );
    return { rows: found, hidden: gated, opening: openingBalance, baseCurrency: base };
  });

  const last = rows.at(-1);
  return c.json(
    {
      items: rows
        .filter((row) => !hidden.has(row.entryId))
        .map((row) => ({
          entryId: row.entryId,
          effectiveDate: row.effectiveDate,
          documentId: row.documentId,
          documentTypeCode: row.documentTypeCode,
          series: row.series,
          number: row.number,
          lineNo: row.lineNo,
          postingSeq: row.postingSeq,
          currency: row.currency,
          exchangeRate: row.exchangeRate,
          debit: { amount: row.debit, currency: row.currency },
          credit: { amount: row.credit, currency: row.currency },
          baseDebit: { amount: row.baseDebit, currency: baseCurrency },
          baseCredit: { amount: row.baseCredit, currency: baseCurrency },
          runningBaseBalance: { amount: row.runningBaseBalance, currency: baseCurrency },
        })),
      next_cursor:
        rows.length === query.limit && last !== undefined
          ? encodeCursor({
              k: [last.effectiveDate, last.postingSeq, last.lineNo],
              id: last.entryId,
            })
          : null,
      opening_base_balance: { amount: opening, currency: baseCurrency },
    },
    200,
  );
});

// ── 3D — the three minimal inventory report codes of §4.16.1, on THIS module ────────────────────────
//
// spec:2300 names one minimal report set — "trial balance, ledger, stock on hand, sales by item" — and
// these three complete it. They are GETs on 1B's router, NOT a new `RouteModule`: the path
// /v1/companies/:companyId/reports is already registered and probed, and `PROBES` is keyed by path.
//
// `inventory.valuation` reads 3B's `valuationAsOf` with 3B's own `ValuationQuery` / `ValuationList`, and
// declares no row type of its own. 3B's `valuationRouteModule` at /v1/companies/:companyId/valuation is
// untouched by this slice: an ordinary list module and a report code are two surfaces over ONE read
// function, which is what 3B's amendment A8 says in terms.

const REPORT_SCOPE = { company: "path:companyId" } as const;

const stockOnHandReportRoute = createRoute({
  method: "get",
  path: "/inventory.stock_on_hand",
  tags: ["inventory"],
  summary: "Stock on hand per item, warehouse and lot (report code inventory.stock_on_hand)",
  middleware: [requirePermission(INVENTORY_PERMISSION.stockRead, REPORT_SCOPE)] as const,
  request: { params: CompanyParams, query: StockOnHandReportQuery },
  responses: {
    200: {
      description: "Stock-on-hand rows",
      content: { "application/json": { schema: StockOnHandReportList } },
    },
    400: {
      description: "Invalid query",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
    403: {
      description: "Forbidden",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
  },
});

reportsRoutes.openapi(stockOnHandReportRoute, async (c) => {
  const { companyId } = c.req.valid("param");
  const query = c.req.valid("query");

  let cursor: { itemCode: string; warehouseCode: string; lotCode: string } | null = null;
  if (query.cursor !== undefined) {
    const decoded = decodeCursor(query.cursor);
    const [item, warehouse, lot] = decoded.k;
    if (
      decoded.k.length !== 3 ||
      typeof item !== "string" ||
      item === "" ||
      typeof warehouse !== "string" ||
      typeof lot !== "string"
    ) {
      throw new AppError(
        "ERR_VALIDATION_FAILED",
        "cursor is not a valid keyset cursor for inventory.stock_on_hand",
      );
    }
    cursor = { itemCode: item, warehouseCode: warehouse, lotCode: lot };
  }

  const itemId = query["filter[item_id][eq]"];
  const warehouseId = query["filter[warehouse_id][eq]"];
  const rows = await c.var.withTenant((tx) =>
    stockOnHand(tx, {
      companyId,
      // `exactOptionalPropertyTypes` is on, so an absent filter is OMITTED, never passed as undefined.
      ...(itemId === undefined ? {} : { itemId }),
      ...(warehouseId === undefined ? {} : { warehouseId }),
      includeInTransit: query.includeInTransit,
      cursor,
      limit: query.limit,
    }),
  );

  const last = rows.at(-1);
  return c.json(
    {
      items: rows,
      next_cursor:
        rows.length === query.limit && last !== undefined
          ? encodeCursor({
              k: [last.itemCode, last.warehouseCode, last.lotCode],
              id: last.lotId,
            })
          : null,
    },
    200,
  );
});

const valuationReportRoute = createRoute({
  method: "get",
  path: "/inventory.valuation",
  tags: ["inventory"],
  summary:
    "Quantity and value per item and warehouse as at a date (report code inventory.valuation)",
  middleware: [requirePermission(INVENTORY_PERMISSION.costRead, REPORT_SCOPE)] as const,
  request: { params: CompanyParams, query: ValuationQuery },
  responses: {
    200: {
      description: "Valuation rows",
      content: { "application/json": { schema: ValuationList } },
    },
    400: {
      description: "Invalid query",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
    403: {
      description: "Forbidden",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
  },
});

reportsRoutes.openapi(valuationReportRoute, async (c) => {
  const { companyId } = c.req.valid("param");
  const query = c.req.valid("query");

  let cursor: { itemCode: string; warehouseCode: string } | null = null;
  if (query.cursor !== undefined) {
    const decoded = decodeCursor(query.cursor);
    const [item, warehouse] = decoded.k;
    if (
      decoded.k.length !== 2 ||
      typeof item !== "string" ||
      item === "" ||
      typeof warehouse !== "string"
    ) {
      throw new AppError(
        "ERR_VALIDATION_FAILED",
        "cursor is not a valid keyset cursor for inventory.valuation",
      );
    }
    cursor = { itemCode: item, warehouseCode: warehouse };
  }

  const itemId = query["filter[item_id][eq]"];
  const warehouseId = query["filter[warehouse_id][eq]"];
  const rows = await c.var.withTenant((tx) =>
    valuationAsOf(tx, {
      companyId,
      asOf: query.asOf,
      ...(itemId === undefined ? {} : { itemId }),
      ...(warehouseId === undefined ? {} : { warehouseId }),
      cursor,
      limit: query.limit,
    }),
  );

  const last = rows.at(-1);
  return c.json(
    {
      items: rows,
      next_cursor:
        rows.length === query.limit && last !== undefined
          ? encodeCursor({ k: [last.itemCode, last.warehouseCode], id: last.warehouseId })
          : null,
    },
    200,
  );
});

const salesByItemRoute = createRoute({
  method: "get",
  path: "/inventory.sales_by_item",
  tags: ["inventory"],
  summary:
    "Delivered quantity, cost, revenue and margin per item over a date range (report code inventory.sales_by_item)",
  description:
    "Gated by inventory.stock.read. cost and margin are null unless the caller also holds " +
    "inventory.cost.read at the report's scope: company-wide, or the filter[branch_id][eq] branch.",
  middleware: [requirePermission(INVENTORY_PERMISSION.stockRead, REPORT_SCOPE)] as const,
  request: { params: CompanyParams, query: SalesByItemQuery },
  responses: {
    200: {
      description:
        "Delivered quantity, cost, revenue and margin per item (cost and margin null without inventory.cost.read)",
      content: { "application/json": { schema: SalesByItemList } },
    },
    400: {
      description: "Invalid query",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
    403: {
      description: "Forbidden",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
  },
});

reportsRoutes.openapi(salesByItemRoute, async (c) => {
  const { companyId } = c.req.valid("param");
  const query = c.req.valid("query");

  let cursor: { itemCode: string } | null = null;
  if (query.cursor !== undefined) {
    const decoded = decodeCursor(query.cursor);
    const [item] = decoded.k;
    if (decoded.k.length !== 1 || typeof item !== "string" || item === "") {
      throw new AppError(
        "ERR_VALIDATION_FAILED",
        "cursor is not a valid keyset cursor for inventory.sales_by_item",
      );
    }
    cursor = { itemCode: item };
  }

  const itemId = query["filter[item_id][eq]"];
  const branchId = query["filter[branch_id][eq]"];
  const { rows, baseCurrency, seesCost } = await c.var.withTenant(async (tx) => {
    // The cost, revenue and margin columns are money, and every wire amount is `{ amount, currency }`
    // (spec:2043). The currency is the company's base — `cost_consumption.value` is stored in it and
    // `revenue` is converted to it on each document's own rate — and it is READ, never defaulted.
    const base = await companyBaseCurrency(tx, companyId);
    // Code review 2, S1. The gate is `inventory.stock.read` (§4.16.1), which the clerk holds, and spec:2158
    // says the clerk "May not: … see costs" (spec:2159 says the same of the warehouse). So cost is a FIELD
    // read, the pattern spec:2158 uses for the staff directory's sensitive fields: `cost` and `margin` —
    // revenue − margin IS the cost — are emitted only to a caller who also holds `inventory.cost.read` at
    // the scope the report covers. A NULL branch asks company-wide authority (§4.2.1, SAH-042), so a
    // branch-restricted cost reader sees the figures when the request narrows to that branch, never wider.
    const [sight] = await tx<{ ok: boolean }[]>`
      select app.actor_has(${INVENTORY_PERMISSION.costRead}, ${companyId}::uuid,
                           ${branchId ?? null}::uuid) as ok`;
    const found = await salesByItem(tx, {
      companyId,
      fromDate: query.fromDate,
      toDate: query.toDate,
      ...(itemId === undefined ? {} : { itemId }),
      ...(branchId === undefined ? {} : { branchId }),
      cursor,
      limit: query.limit,
    });
    return { rows: found, baseCurrency: base, seesCost: sight?.ok === true };
  });

  const last = rows.at(-1);
  return c.json(
    {
      items: rows.map((row) => ({
        itemId: row.itemId,
        itemCode: row.itemCode,
        itemNameEn: row.itemNameEn,
        deliveredQuantity: row.deliveredQuantity,
        cost: seesCost ? { amount: row.cost, currency: baseCurrency } : null,
        revenue: { amount: row.revenue, currency: baseCurrency },
        margin: seesCost ? { amount: row.margin, currency: baseCurrency } : null,
      })),
      next_cursor:
        rows.length === query.limit && last !== undefined
          ? encodeCursor({ k: [last.itemCode], id: last.itemId })
          : null,
    },
    200,
  );
});

// ── 4B — accounting.ageing (§4.16.1, §4.8.2) ─────────────────────────────────────────────────────────
//
// One GET on THIS module, not a new `RouteModule`: the /v1/companies/:companyId/reports path is already
// registered and probed, and `PROBES` is keyed by path (hazard 31). It reads `agedBalance` — FRESH, through
// `app.party_ageing_rows`, never the stored snapshot (ADR 0046) — and adds nothing to its figures.
//
// The filters go through `parseFilters` (§4.2.8 Layer 2 names this route), so no field name reaches SQL as
// text (test 27): every declared field maps through the closed switch below onto a typed parameter, each
// with its own operators and value grammar, and anything else — an undeclared field, a second clause on one
// field, an operator the field does not take, a query key outside the grammar — is ERR_VALIDATION_FAILED.

const ageingRoute = createRoute({
  method: "get",
  path: "/accounting.ageing",
  tags: ["accounting"],
  summary: "AR/AP ageing per party and currency as at a date (report code accounting.ageing)",
  description:
    "filter[as_of][eq]=YYYY-MM-DD is required. Optional: filter[party_id][eq], filter[party_kind][eq], " +
    "filter[currency][eq], filter[bucket][eq|in] (current, 1_30, 31_60, 61_90, over_90; `in` is " +
    "comma-separated). Buckets are cut on the document's effective date plus the payment term pinned on it.",
  middleware: [requirePermission(PERMISSION["accounting.report.read"], REPORT_SCOPE)] as const,
  request: { params: CompanyParams, query: AgeingQuery },
  responses: {
    200: {
      description: "One row per party and currency with a non-zero open figure",
      content: { "application/json": { schema: AgeingList } },
    },
    400: {
      description: "Invalid query",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
    403: {
      description: "Forbidden",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
  },
});

/** `ListQuery`'s own four keys: the only flat parameters §4.2.8 Layer 1 leaves this route. */
const LIST_QUERY_KEYS = new Set(["cursor", "limit", "sort", "fields"]);

function invalidFilter(path: string, message: string): AppError {
  return new AppError("ERR_VALIDATION_FAILED", `${path}: ${message}`, {
    errors: [{ path, message }],
  });
}

/** The raw query → `agedBalance`'s typed filters, or ERR_VALIDATION_FAILED naming the offending key. */
function ageingFilters(
  raw: Record<string, string[]>,
): Omit<AgedBalanceParams, "companyId" | "limit" | "cursor"> {
  const clauses = parseFilters(raw);
  const parsedKeys = new Set(clauses.map((c) => `filter[${c.field}][${c.op}]`));
  for (const [key, values] of Object.entries(raw)) {
    if (!LIST_QUERY_KEYS.has(key) && !parsedKeys.has(key)) {
      throw invalidFilter(key, "is not a query parameter of accounting.ageing");
    }
    if (values.length > 1) throw invalidFilter(key, "is given more than once");
  }

  const out: Omit<AgedBalanceParams, "companyId" | "limit" | "cursor"> = { asOf: "" };
  const seen = new Set<string>();
  for (const clause of clauses) {
    const path = `filter[${clause.field}][${clause.op}]`;
    if (seen.has(clause.field)) throw invalidFilter(path, "a field takes one clause");
    seen.add(clause.field);
    const eqOnly = () => {
      if (clause.op !== "eq") throw invalidFilter(path, `${clause.field} takes only eq`);
    };
    switch (clause.field) {
      case "as_of":
        eqOnly();
        // DateSchema refines with the shared `isCalendarDate`: postgres.js would roll 2026-02-30 over.
        if (!DateSchema.safeParse(clause.value).success)
          throw invalidFilter(path, "must be a calendar date YYYY-MM-DD");
        out.asOf = clause.value;
        break;
      case "party_id":
        eqOnly();
        if (!UuidSchema.safeParse(clause.value).success)
          throw invalidFilter(path, "must be a uuid");
        out.partyId = clause.value;
        break;
      case "party_kind": {
        eqOnly();
        const kind = PartyKindSchema.safeParse(clause.value);
        if (!kind.success) throw invalidFilter(path, "must be a party kind");
        out.partyKind = kind.data;
        break;
      }
      case "currency":
        eqOnly();
        if (!CurrencySchema.safeParse(clause.value).success) {
          throw invalidFilter(path, "must be a three-letter currency code");
        }
        out.currency = clause.value;
        break;
      case "bucket": {
        if (clause.op !== "eq" && clause.op !== "in")
          throw invalidFilter(path, "bucket takes eq or in");
        const buckets = clause.op === "in" ? clause.value.split(",") : [clause.value];
        const known = PARTY_AGEING_BUCKETS as readonly string[];
        if (buckets.some((b) => !known.includes(b))) {
          throw invalidFilter(
            path,
            `each bucket must be one of ${PARTY_AGEING_BUCKETS.join(", ")}`,
          );
        }
        out.buckets = buckets as AgeingBucket[];
        break;
      }
      default:
        throw invalidFilter(
          path,
          `is not declared on accounting.ageing (declared: ${AGEING_FILTER_FIELDS.join(", ")})`,
        );
    }
  }
  if (out.asOf === "") throw invalidFilter("filter[as_of][eq]", "is required");
  return out;
}

reportsRoutes.openapi(ageingRoute, async (c) => {
  const { companyId } = c.req.valid("param");
  const query = c.req.valid("query");
  const filters = ageingFilters(c.req.queries());

  let cursor: { partyCode: string; currency: string } | null = null;
  if (query.cursor !== undefined) {
    const decoded = decodeCursor(query.cursor);
    const [code, ccy] = decoded.k;
    if (
      decoded.k.length !== 2 ||
      typeof code !== "string" ||
      code === "" ||
      typeof ccy !== "string" ||
      !CURRENCY.test(ccy)
    ) {
      throw new AppError(
        "ERR_VALIDATION_FAILED",
        "cursor is not a valid keyset cursor for accounting.ageing",
      );
    }
    cursor = { partyCode: code, currency: ccy };
  }

  const rows = await c.var.withTenant((tx) =>
    agedBalance(tx, { companyId, ...filters, cursor, limit: query.limit }),
  );

  const last = rows.at(-1);
  return c.json(
    {
      // `party.kind` is a text column under `party_kind_check`, so the narrowing to the wire enum cannot fail.
      items: rows.map((row) => ({ ...row, partyKind: PartyKindSchema.parse(row.partyKind) })),
      next_cursor:
        rows.length === query.limit && last !== undefined
          ? encodeCursor({ k: [last.partyCode, last.currency], id: last.partyId })
          : null,
    },
    200,
  );
});

/**
 * The module 7A extends with POST …/reports/{code}/runs. It must stay ONE module on this path:
 * `PROBES` (tests/invariants/probes.ts) is keyed by `RouteModule.path`, so a second module sharing the
 * path would collide. The `RouteModule` import is type-only, so nothing circular survives to runtime.
 */
export const reportsRouteModule: RouteModule = {
  path: "/v1/companies/:companyId/reports",
  router: reportsRoutes,
  permissions: [
    PERMISSION["pos.report.read"],
    PERMISSION["accounting.report.read"],
    PERMISSION["accounting.ledger.read"],
    // 3D — the three inventory report codes of §4.16.1 live on THIS module, not on a second one at the
    // same path: `PROBES` is keyed by `RouteModule.path` and a second entry would collide (hazard 31).
    INVENTORY_PERMISSION.stockRead,
    INVENTORY_PERMISSION.costRead,
    // 7A — POST …/{code}/runs. Its gate is `reportExportRequestGate` (the export code, ADR 0067 decision 6)
    // and the definition's own read code is evaluated from data inside the handler.
    PERMISSION["accounting.report.export"],
  ],
  auth: "human",
};

import { salesByCashier, zReport, ReportParamError } from "@dulja/db";
import {
  ZReportTenderSchema,
  SalesByCashierList,
  SalesByCashierQuery,
  ZReportList,
  ZReportQuery,
} from "@dulja/contracts/pos/reports";

const zReportRoute = createRoute({
  method: "get",
  path: "/pos.z_report",
  request: { params: z.object({ companyId: UuidSchema }), query: ZReportQuery },
  responses: {
    200: { content: { "application/json": { schema: ZReportList } }, description: "Z-report(s)" },
    400: {
      description: "request failed",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
    403: {
      description: "request failed",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
    404: {
      description: "request failed",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
  },
  middleware: [staffBranchGate(PERMISSION["pos.report.read"])],
  tags: ["pos"],
});

reportsRoutes.openapi(zReportRoute, async (c) => {
  const { companyId } = c.req.valid("param");
  const q = c.req.valid("query");

  let cursor: { openedAt: string; shiftId: string } | null = null;
  if (q.cursor !== undefined) {
    const d = decodeCursor(q.cursor);
    if (
      d.k.length !== 1 ||
      !z.string().datetime({ offset: true }).safeParse(d.k[0]).success ||
      !UuidSchema.safeParse(d.id).success ||
      typeof d.k[0] !== "string"
    ) {
      throw new AppError(
        "ERR_VALIDATION_FAILED",
        "cursor is not a valid keyset cursor for pos.z_report",
      );
    }
    cursor = { openedAt: d.k[0], shiftId: d.id };
  }

  // **No `baseCurrency` here, unlike the `sales_by_cashier` handler below.** Every money member of the
  // Z-report DTO takes its currency from `z.currency` — the shift's own, per amendment A3 — so the
  // company's base currency is never read on this path. Destructuring it would be an unused local, which
  // `noUnusedLocals` and the repo lint both fail, and Step 8 expects green.
  const rows = await c.var.withTenant(async (tx) => {
    try {
      return await zReport(tx, {
        companyId,
        ...(q.shiftId ? { shiftId: q.shiftId } : {}),
        ...(q.branchId ? { branchId: q.branchId } : {}),
        ...(q.from ? { from: q.from } : {}),
        ...(q.to ? { to: q.to } : {}),
        cursor,
        limit: q.limit + 1,
      });
    } catch (e) {
      // 4B's pattern: a db-tier error class whose `code` is already an `ErrCode`, so no branch and no cast.
      if (e instanceof ReportParamError) throw new AppError(e.code, e.detail);
      throw e;
    }
  });

  const page = rows.slice(0, q.limit);
  const last = page.at(-1);
  return c.json(
    {
      items: page.map((report) => ({
        shiftId: report.shiftId,
        branchId: report.branchId,
        terminalId: report.terminalId,
        terminalCode: report.terminalCode,
        // Milliseconds on the wire, as the shift list shows them. `report.openedAt` itself is exact to the
        // microsecond because it is the keyset key, and `next_cursor` below carries it unrounded.
        openedAt: new Date(report.openedAt).toISOString(),
        closedAt: report.closedAt,
        openedPrincipalId: report.openedPrincipalId,
        closedPrincipalId: report.closedPrincipalId,
        currency: report.currency,
        openingFloat: { amount: report.openingFloat, currency: report.currency },
        countedCash:
          report.countedCash === null
            ? null
            : { amount: report.countedCash, currency: report.currency },
        expectedCash:
          report.expectedCash === null
            ? null
            : { amount: report.expectedCash, currency: report.currency },
        overShort:
          report.overShort === null
            ? null
            : { amount: report.overShort, currency: report.currency },
        overShortDocumentId: report.overShortDocumentId,
        ticketCount: report.ticketCount,
        returnCount: report.returnCount,
        tenders: report.tenders.map((t) => ({
          method: ZReportTenderSchema.shape.method.parse(t.method),
          accountCode: t.accountCode,
          amount: { amount: t.amount, currency: t.currency },
        })),
        cashControl: report.cashControl.map((x) => ({
          documentTypeCode: x.documentTypeCode,
          amount: { amount: x.amount, currency: x.currency },
        })),
        tillEvents: report.tillEvents,
      })),
      next_cursor:
        rows.length > q.limit && last !== undefined
          ? encodeCursor({ k: [last.openedAt], id: last.shiftId })
          : null,
    },
    200,
  );
});

const salesByCashierRoute = createRoute({
  method: "get",
  path: "/pos.sales_by_cashier",
  request: { params: z.object({ companyId: UuidSchema }), query: SalesByCashierQuery },
  responses: {
    200: {
      content: { "application/json": { schema: SalesByCashierList } },
      description: "Sales per cashier",
    },
    400: {
      description: "request failed",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
    403: {
      description: "request failed",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
  },
  middleware: [staffBranchGate(PERMISSION["pos.report.read"])],
  tags: ["pos"],
});

reportsRoutes.openapi(salesByCashierRoute, async (c) => {
  const { companyId } = c.req.valid("param");
  const q = c.req.valid("query");

  // The cursor is a single-key keyset on the cashier's principal id — the query's own `order by`. `k` is
  // empty because the id IS the ordering key and `decodeCursor` already carries it as `id`.
  let cursor: { cashierPrincipalId: string; branchId: string } | null = null;
  if (q.cursor !== undefined) {
    const d = decodeCursor(q.cursor);
    if (
      d.k.length !== 1 ||
      !UuidSchema.safeParse(d.id).success ||
      !UuidSchema.safeParse(d.k[0]).success ||
      typeof d.k[0] !== "string"
    ) {
      throw new AppError(
        "ERR_VALIDATION_FAILED",
        "cursor is not a valid keyset cursor for pos.sales_by_cashier",
      );
    }
    cursor = { cashierPrincipalId: d.id, branchId: d.k[0] };
  }

  const rows = await c.var.withTenant(async (tx) => {
    try {
      return await salesByCashier(tx, {
        companyId,
        from: q.from,
        to: q.to,
        ...(q.branchId ? { branchId: q.branchId } : {}),
        ...(q.cashierPrincipalId ? { cashierPrincipalId: q.cashierPrincipalId } : {}),
        cursor,
        limit: q.limit + 1,
      });
    } catch (e) {
      if (e instanceof ReportParamError) throw new AppError(e.code, e.detail);
      throw e;
    }
  });

  const page = rows.slice(0, q.limit);
  const last = page.at(-1);
  return c.json(
    {
      // **The four `Base`-suffix renames, in the one place they happen.** `salesByCashier` returns
      // `netSalesBase`, `discountBase`, `cashRoundingBase` and `overShortBase`; `SalesByCashierRowSchema`
      // names them `netSales`, `discount`, `cashRounding` and `overShort`. The suffix earns its keep inside
      // `packages/db`, where a bare `netSales` could be read as a document-currency figure; on the wire the
      // `{ amount, currency }` pair already says which money it is, and `currency` is `baseCurrency` on all
      // four because the function returns base amounts (§4.16.3, amendment A5). `discount` is manual
      // discounts only and `cashRounding` the automatic rounding beside it (ADR 0059, 2026-10-22).
      items: page.map((r) => ({
        cashierPrincipalId: r.cashierPrincipalId,
        cashierName: r.cashierName,
        branchId: r.branchId,
        ticketCount: r.ticketCount,
        returnCount: r.returnCount,
        netSales: { amount: r.netSalesBase, currency: r.baseCurrency },
        discount: { amount: r.discountBase, currency: r.baseCurrency },
        cashRounding: { amount: r.cashRoundingBase, currency: r.baseCurrency },
        overShort: { amount: r.overShortBase, currency: r.baseCurrency },
      })),
      next_cursor:
        rows.length > q.limit && last !== undefined
          ? encodeCursor({ k: [last.branchId], id: last.cashierPrincipalId })
          : null,
    },
    200,
  );
});

// ── 7A Task 12 — POST /v1/companies/{companyId}/reports/{code}/runs (contracts §4.11.2) ────────────────
// A sub-path on THIS module, never a second module on the same path (hazard 31). The run resource it points
// at is its own module, `report-runs.ts`.
const reportRunRoute = createRoute({
  method: "post",
  path: "/{code}/runs",
  tags: ["reports"],
  summary: "Queue a server-side render of a report definition as PDF, XLSX or CSV",
  // The export code is the route's gate (see reportExportRequestGate); the definition's read code is a
  // data value and is evaluated in the handler (apps/api/src/reports/authorise.ts).
  middleware: [reportExportRequestGate] as const,
  request: {
    headers: IdempotencyHeader,
    params: z.object({ companyId: UuidSchema, code: z.string().regex(REPORT_CODE_PATTERN) }),
    body: { required: true, content: { "application/json": { schema: CreateReportRunBody } } },
  },
  responses: {
    202: {
      description: "The render is queued; poll statusUrl",
      content: { "application/json": { schema: ReportRunAcceptedSchema } },
    },
    400: {
      description: "Invalid body or parameters",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
    403: {
      description: "Forbidden",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
    404: {
      description: "No live definition for the code",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
  },
});

reportsRoutes.openapi(reportRunRoute, async (c) => {
  const { companyId, code } = c.req.valid("param");
  const body = c.req.valid("json");

  // GATE ORDER IS DELIBERATE. The export code was evaluated by the route gate, on the path alone, before any
  // row was read — so a caller with no codes is refused 403 whether or not a definition exists, and the route
  // is never an existence oracle for a company's report catalogue. Only now is the definition resolved (404
  // if there is none) and its own read code evaluated.
  const { id, definition } = await resolveDefinitionForRun(
    c,
    companyId,
    code,
    body.reportDefinitionId,
  );
  await requireReportRead(c, companyId, definition.permission);
  // The stored definition's gate, re-checked before a run is queued (second review, finding 8): a row written
  // before a gate rule existed, or by a path that bypassed the store, is refused 400 here rather than queued to
  // read under a wider gate. The worker checks again when it renders (`rowsForDefinition`).
  assertDatasetGate(definition);
  assertParameters(definition, body.parameters);
  if (body.savedViewId !== undefined)
    await assertSavedViewForRun(c, companyId, id, body.savedViewId);

  // The run row and the pg-boss job are inserted in ONE transaction: the job goes through `tx`, so it is
  // visible only after the commit and never on a rollback (§4.2.6, spec:2321). A rolled-back request
  // therefore leaves neither a queued run nor a job that would fail looking for it.
  const { runId, jobId } = await c.var.withTenant(async (tx) => {
    const run = await createReportRun(tx, {
      companyId,
      reportDefinitionId: id,
      savedViewId: body.savedViewId ?? null,
      parameters: body.parameters,
      format: body.format,
      lang: body.lang,
    });
    // The lease's options, stated (Phase 7 review, finding 2): a worker that dies mid-render is redelivered
    // after the lease and reclaims the run, and a run that never finishes ends `failed`, not `running`.
    const job = await c.var.jobs.enqueue(
      tx,
      "reporting.render",
      {
        tenantId: c.var.ctx.tenantId,
        requestId: c.var.ctx.requestId,
        payload: { runId: run.id },
      },
      REPORT_RUN_JOB_OPTIONS,
    );
    return { runId: run.id, jobId: job };
  });

  return c.json(
    { runId, jobId, statusUrl: `/v1/companies/${companyId}/report-runs/${runId}` },
    202,
  );
});
