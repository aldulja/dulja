// apps/api/src/routes/accounting/bank-statements.ts
//
// Slice 4B. The bank-reconciliation route module (Task 8) — this slice's only new `RouteModule`, and therefore
// its only new `PROBES` key (hazard 31): the ageing report is a GET on 1B's reports module and the revaluation a
// POST on 1A's documents module. Task 2 created the file with `BANK_PERMISSION` alone, because
// scripts/lint/rules/permission-catalogue.ts (§3.6.3) scans apps/api, apps/worker, apps/pos, packages/sync and
// packages/db/src — not packages/contracts/src — and packages/db may not import @dulja/contracts (§3.1), so
// apps/api is the only legal home for the reference.
//
// Six sub-paths, every one gated `accounting.bank.reconcile` in the PATH company. Gating a GET with a mutating
// code is legal and deliberate: R7 (`assertRouteGates`, §3.6.3) refuses an UNSAFE method gated by a
// `mutating: false` code, never the reverse, and §4.16.1 makes the same choice for 7C's
// accounting.unreconciled_items ("only a reconciler sees it").
//
// RLS bounds the tenant and nothing else (AGENTS.md), so every handler passes the path company into every
// service call, and resolves every id the path or body names — the bank account, the statement, the line, the
// match — inside that company before acting, answering ERR_NOT_FOUND for one that is not there.
//
// No error translation lives here: `ImportError` and `BankMatchError` (packages/db) carry a `readonly code`
// that is a member of `ERRORS`, and `apps/api/src/problem.ts`'s coded-error branch (`fromDomainError`) already
// lifts any such error into its problem+json — so this file adds no branch there and no rethrow of its own.
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import {
  AppError,
  BankMatchSchema,
  BankStatementLineList,
  BankStatementLineQuery,
  BankStatementList,
  BankStatementQuery,
  CreateBankMatchBody,
  DateSchema,
  decodeCursor,
  encodeCursor,
  ImportStatementBody,
  ProblemSchema,
  ReconciledBalanceSchema,
  ReconciliationQuery,
  UnmatchBody,
  UuidSchema,
  type BankMatchDto,
} from "@dulja/contracts";
import { PERMISSION } from "@dulja/contracts/permissions";
import {
  importStatement,
  listStatementLines,
  listStatements,
  match,
  reconciledBalance,
  unmatch,
  unmatchedStatementLines,
  type CsvMapping,
} from "@dulja/db";
import { Money } from "@dulja/domain";
import type { AppEnv } from "../../context";
import { requirePermission } from "../../middleware/require-permission";
import { IdempotencyHeader } from "../idempotency-header";
// Type-only, so nothing circular survives to runtime (the shape `paymentTermRouteModule` uses).
import type { RouteModule } from "../index";

/** 3A's INVENTORY_PERMISSION precedent: one home for the slice's codes, so no route writes the literal. */
export const BANK_PERMISSION = {
  reconcile: PERMISSION["accounting.bank.reconcile"],
} as const;

export const bankStatementRoutes = new OpenAPIHono<AppEnv>({
  defaultHook: (result) => {
    if (!result.success) throw result.error;
  },
});

const gate = () => requirePermission(BANK_PERMISSION.reconcile, { company: "path:companyId" });

const CompanyParams = z.object({ companyId: UuidSchema });
const StatementParams = CompanyParams.extend({ statementId: UuidSchema });
const LineParams = StatementParams.extend({ lineId: UuidSchema });
const MatchParams = CompanyParams.extend({ matchId: UuidSchema });

const problem = (description: string) => ({
  description,
  content: { "application/problem+json": { schema: ProblemSchema } },
});

type Tx = Parameters<Parameters<AppEnv["Variables"]["withTenant"]>[0]>[0];

// ── the path company's binding: every id resolved inside it, or ERR_NOT_FOUND ────────────────────────────────

async function assertBankAccount(tx: Tx, companyId: string, bankAccountId: string): Promise<void> {
  const [row] = await tx<{ id: string }[]>`
    select id from app.account where id = ${bankAccountId} and company_id = ${companyId}`;
  if (!row) {
    throw new AppError("ERR_NOT_FOUND", `no account ${bankAccountId} in company ${companyId}`);
  }
}

async function assertStatement(tx: Tx, companyId: string, statementId: string): Promise<void> {
  const [row] = await tx<{ id: string }[]>`
    select id from app.bank_statement where id = ${statementId} and company_id = ${companyId}`;
  if (!row) {
    throw new AppError("ERR_NOT_FOUND", `no bank statement ${statementId} in company ${companyId}`);
  }
}

/** The line must be a line of the PATH statement, not merely of the company: a line id alone would let
 *  `…/statements/A/lines/<a line of B>/matches` match a statement the path does not name. */
async function assertLine(
  tx: Tx,
  companyId: string,
  statementId: string,
  lineId: string,
): Promise<void> {
  const [row] = await tx<{ id: string }[]>`
    select id from app.bank_statement_line
     where id = ${lineId} and statement_id = ${statementId} and company_id = ${companyId}`;
  if (!row) {
    throw new AppError(
      "ERR_NOT_FOUND",
      `no line ${lineId} on bank statement ${statementId} in company ${companyId}`,
    );
  }
}

/** One `app.bank_match` row of the company, in its statement's currency, or undefined. */
async function matchRow(
  tx: Tx,
  companyId: string,
  matchId: string,
): Promise<BankMatchDto | undefined> {
  const [row] = await tx<
    {
      id: string;
      statement_line_id: string;
      reconcilable_kind: BankMatchDto["kind"];
      reconcilable_document_id: string;
      amount: string;
      currency: string;
      matched_at: Date;
      unmatched_at: Date | null;
      unmatch_reason: string | null;
    }[]
  >`
    select bm.id, bm.statement_line_id, bm.reconcilable_kind, bm.reconcilable_document_id,
           bm.amount::text as amount, st.currency, bm.matched_at, bm.unmatched_at, bm.unmatch_reason
      from app.bank_match bm
      join app.bank_statement_line l on l.id = bm.statement_line_id and l.company_id = bm.company_id
      join app.bank_statement st on st.id = l.statement_id and st.company_id = l.company_id
     where bm.id = ${matchId} and bm.company_id = ${companyId}`;
  if (!row) return undefined;
  return {
    id: row.id,
    statementLineId: row.statement_line_id,
    kind: row.reconcilable_kind,
    reconcilableDocumentId: row.reconcilable_document_id,
    amount: { amount: row.amount, currency: row.currency },
    matchedAt: row.matched_at.toISOString(),
    unmatchedAt: row.unmatched_at?.toISOString() ?? null,
    unmatchReason: row.unmatch_reason,
  };
}

/**
 * The wire mapping as `importStatement` takes it. Zod's optional keys are `T | undefined` and `CsvMapping`'s are
 * absent-or-`T` (`exactOptionalPropertyTypes`), so every key the body leaves out stays absent — nothing else
 * changes, and nothing is defaulted here that the service defaults itself.
 */
function toCsvMapping(wire: z.infer<typeof ImportStatementBody>["mapping"]): CsvMapping {
  const c = wire.columns;
  return {
    statement: wire.statement,
    columns: {
      valueDate: c.valueDate,
      description: c.description,
      ...(c.reference === undefined ? {} : { reference: c.reference }),
      ...(c.amount === undefined ? {} : { amount: c.amount }),
      ...(c.debit === undefined ? {} : { debit: c.debit }),
      ...(c.credit === undefined ? {} : { credit: c.credit }),
    },
    dateFormat: wire.dateFormat,
    hasHeader: wire.hasHeader,
    ...(wire.delimiter === undefined ? {} : { delimiter: wire.delimiter }),
    ...(wire.decimalComma === undefined ? {} : { decimalComma: wire.decimalComma }),
  };
}

// ── the two keysets (the shared cursor codec, §4.2.8) ──────────────────────────────────────────────────────

/** `listStatements` orders `statement_date desc, id`, so its cursor is `k: [statementDate]` plus the id. */
function statementCursor(raw: string): { statementDate: string; id: string } {
  const decoded = decodeCursor(raw);
  const [statementDate] = decoded.k;
  if (
    decoded.k.length !== 1 ||
    typeof statementDate !== "string" ||
    !DateSchema.safeParse(statementDate).success ||
    !UuidSchema.safeParse(decoded.id).success
  ) {
    throw new AppError("ERR_VALIDATION_FAILED", "cursor is not a valid bank-statement cursor");
  }
  return { statementDate, id: decoded.id };
}

/** `listStatementLines` orders by `line_no`, so its cursor is `k: [lineNo]` plus the line's id. */
function lineCursor(raw: string): number {
  const decoded = decodeCursor(raw);
  const [lineNo] = decoded.k;
  if (
    decoded.k.length !== 1 ||
    typeof lineNo !== "number" ||
    !Number.isInteger(lineNo) ||
    lineNo < 1 ||
    !UuidSchema.safeParse(decoded.id).success
  ) {
    throw new AppError("ERR_VALIDATION_FAILED", "cursor is not a valid statement-line cursor");
  }
  return lineNo;
}

// ── the six sub-paths ─────────────────────────────────────────────────────────────────────────────────────

bankStatementRoutes.openapi(
  createRoute({
    method: "post",
    path: "/",
    tags: ["accounting"],
    middleware: [gate()] as const,
    summary: "Import a bank statement from CSV; it must add up (opening + Σ lines = closing)",
    request: {
      params: CompanyParams,
      headers: IdempotencyHeader,
      body: { content: { "application/json": { schema: ImportStatementBody } } },
    },
    responses: {
      201: {
        description: "The imported statement and its line count",
        content: {
          "application/json": {
            schema: z.object({ statementId: UuidSchema, lines: z.number().int() }),
          },
        },
      },
      400: problem(
        "ERR_VALIDATION_FAILED — the statement does not add up, or the mapping is wrong",
      ),
      403: problem("Forbidden"),
      404: problem("The bank account is not an account of this company"),
      409: problem("ERR_CONFLICT_UNIQUE — a statement already exists for that account and date"),
    },
  }),
  async (c) => {
    const { companyId } = c.req.valid("param");
    const { bankAccountId, csv, mapping } = c.req.valid("json");
    const result = await c.var.withTenant(async (tx) => {
      await assertBankAccount(tx, companyId, bankAccountId);
      return importStatement(tx, c.var.ctx, {
        companyId,
        bankAccountId,
        csv,
        mapping: toCsvMapping(mapping),
      });
    });
    return c.json(result, 201);
  },
);

bankStatementRoutes.openapi(
  createRoute({
    method: "get",
    path: "/",
    tags: ["accounting"],
    middleware: [gate()] as const,
    summary: "List the company's bank statements, newest first",
    request: { params: CompanyParams, query: BankStatementQuery },
    responses: {
      200: {
        description: "Statements, keyset-paged on (statement_date desc, id)",
        content: { "application/json": { schema: BankStatementList } },
      },
      400: problem("Invalid query or cursor"),
      403: problem("Forbidden"),
    },
  }),
  async (c) => {
    const { companyId } = c.req.valid("param");
    const q = c.req.valid("query");
    const after = q.cursor ? statementCursor(q.cursor) : null;
    const bankAccountId = q["filter[bank_account_id][eq]"];
    // One row past the page decides whether there IS a next page (4A's payment-terms list).
    const rows = await c.var.withTenant((tx) =>
      listStatements(tx, {
        companyId,
        ...(bankAccountId === undefined ? {} : { bankAccountId }),
        after,
        limit: q.limit + 1,
      }),
    );
    const page = rows.slice(0, q.limit);
    const last = page.at(-1);
    return c.json(
      {
        items: page,
        next_cursor:
          rows.length > q.limit && last
            ? encodeCursor({ k: [last.statementDate], id: last.id })
            : null,
      },
      200,
    );
  },
);

bankStatementRoutes.openapi(
  createRoute({
    method: "get",
    path: "/{statementId}/lines",
    tags: ["accounting"],
    middleware: [gate()] as const,
    summary: "A statement's lines with their matched amount; filter[matched][eq] splits them",
    request: { params: StatementParams, query: BankStatementLineQuery },
    responses: {
      200: {
        description:
          "Lines in line order, keyset-paged. filter[matched][eq]=false: the lines whose magnitude still exceeds " +
          "their live matches (the partly matched included); =true: the fully matched lines; absent: every line",
        content: { "application/json": { schema: BankStatementLineList } },
      },
      400: problem("Invalid query or cursor"),
      403: problem("Forbidden"),
      404: problem("ERR_NOT_FOUND — no such statement in this company"),
    },
  }),
  async (c) => {
    const { companyId, statementId } = c.req.valid("param");
    const q = c.req.valid("query");
    const afterLineNo = q.cursor ? lineCursor(q.cursor) : null;
    // §4.2.8 Layer 2's literal key, validated by Zod as the two strings "true"/"false", so no coercion can
    // turn "false" into true.
    const matched = q["filter[matched][eq]"];
    const rows = await c.var.withTenant(async (tx) => {
      await assertStatement(tx, companyId, statementId);
      return listStatementLines(tx, {
        companyId,
        statementId,
        unmatchedOnly: matched === "false",
        matchedOnly: matched === "true",
        afterLineNo,
        limit: q.limit + 1,
      });
    });
    const page = rows.slice(0, q.limit);
    const last = page.at(-1);
    return c.json(
      {
        items: page,
        next_cursor:
          rows.length > q.limit && last ? encodeCursor({ k: [last.lineNo], id: last.id }) : null,
      },
      200,
    );
  },
);

bankStatementRoutes.openapi(
  createRoute({
    method: "post",
    path: "/{statementId}/lines/{lineId}/matches",
    tags: ["accounting"],
    middleware: [gate()] as const,
    summary:
      "Match part or all of a statement line to one receipt or payment; writes app.bank_match only",
    request: {
      params: LineParams,
      headers: IdempotencyHeader,
      body: { content: { "application/json": { schema: CreateBankMatchBody } } },
    },
    responses: {
      201: {
        description: "The match; no ledger entry is written, altered or removed (ADR 0048)",
        content: { "application/json": { schema: z.object({ matchId: UuidSchema }) } },
      },
      400: problem("Invalid body"),
      403: problem("Forbidden"),
      404: problem("ERR_NOT_FOUND — no such line on this statement in this company"),
      422: problem(
        "ERR_BANK_MATCH_AMOUNT — the direction, the currency, the document or the remaining amount disagrees",
      ),
    },
  }),
  async (c) => {
    const { companyId, statementId, lineId } = c.req.valid("param");
    const body = c.req.valid("json");
    const result = await c.var.withTenant(async (tx) => {
      await assertLine(tx, companyId, statementId, lineId);
      return match(tx, c.var.ctx, {
        companyId,
        statementLineId: lineId,
        reconcilable: { kind: body.kind, documentId: body.documentId },
        amount: Money.fromJSON(body.amount),
      });
    });
    return c.json(result, 201);
  },
);

bankStatementRoutes.openapi(
  createRoute({
    method: "post",
    path: "/matches/{matchId}/unmatch",
    tags: ["accounting"],
    middleware: [gate()] as const,
    summary: "Unmatch one live match, with its compelled reason; the row survives (spec:2049)",
    request: {
      params: MatchParams,
      headers: IdempotencyHeader,
      body: { content: { "application/json": { schema: UnmatchBody } } },
    },
    responses: {
      // 200 with the row, not the plan's 204: the idempotency layer replays a stored answer as
      // `new Response(JSON.stringify(body), { status })`, and a 204 may carry no body, so a replayed 204 would
      // throw inside the middleware. 4A's unallocate answers the same way, with its reversed row.
      200: {
        description: "Unmatched; unmatchedAt, the unmatcher and the reason are stored on the row",
        content: { "application/json": { schema: BankMatchSchema } },
      },
      400: problem("Invalid body, or a blank reason"),
      403: problem("Forbidden"),
      404: problem("ERR_NOT_FOUND — no such match in this company"),
      422: problem("ERR_BANK_MATCH_AMOUNT — the match is already unmatched"),
    },
  }),
  async (c) => {
    const { companyId, matchId } = c.req.valid("param");
    const { reason } = c.req.valid("json");
    const row = await c.var.withTenant(async (tx) => {
      if (!(await matchRow(tx, companyId, matchId))) {
        throw new AppError("ERR_NOT_FOUND", `no bank match ${matchId} in company ${companyId}`);
      }
      await unmatch(tx, c.var.ctx, { companyId, matchId, reason });
      return matchRow(tx, companyId, matchId);
    });
    if (row === undefined) throw new AppError("ERR_NOT_FOUND", "the bank match is not visible");
    return c.json(row, 200);
  },
);

bankStatementRoutes.openapi(
  createRoute({
    method: "get",
    path: "/reconciliation",
    tags: ["accounting"],
    // A mutating code on a GET: legal under R7, and deliberate (see the file header).
    middleware: [gate()] as const,
    summary:
      "The reconciliation as at a date: statement and ledger balance, and what is not yet matched",
    description:
      "filter[bank_account_id][eq] and filter[as_of][eq] (YYYY-MM-DD) are both required. `statement` is the " +
      "closing balance of the latest statement dated on or before as_of; `ledger` the account's balance at " +
      "as_of in its own currency; `unreconciled` every registered source's unmatched documents; " +
      "`unmatchedLines` every statement line whose magnitude still exceeds its live matches.",
    request: { params: CompanyParams, query: ReconciliationQuery },
    responses: {
      200: {
        description: "Statement, ledger, the unreconciled items and the unmatched statement lines",
        content: { "application/json": { schema: ReconciledBalanceSchema } },
      },
      400: problem("ERR_VALIDATION_FAILED — a filter is missing, malformed or undeclared"),
      403: problem("Forbidden"),
      404: problem("ERR_NOT_FOUND — the bank account is not an account of this company"),
    },
  }),
  async (c) => {
    const { companyId } = c.req.valid("param");
    const q = c.req.valid("query");
    const bankAccountId = q["filter[bank_account_id][eq]"];
    const asOf = q["filter[as_of][eq]"];
    const result = await c.var.withTenant(async (tx) => {
      await assertBankAccount(tx, companyId, bankAccountId);
      const balance = await reconciledBalance(tx, { companyId, bankAccountId, asOf });
      // reconciledBalance's frozen return has no member for unmatched STATEMENT lines (§4.8.3), so the route
      // composes the two halves rather than widening a registered type (ADR 0048).
      const unmatchedLines = await unmatchedStatementLines(tx, { companyId, bankAccountId, asOf });
      return {
        statement: balance.statement.toJSON(),
        ledger: balance.ledger.toJSON(),
        unreconciled: balance.unreconciled.map((r) => ({
          kind: r.kind,
          documentId: r.documentId,
          bankAccountId: r.bankAccountId,
          valueDate: r.valueDate,
          amount: r.amount.toJSON(),
          reference: r.reference,
        })),
        unmatchedLines,
      };
    });
    return c.json(result, 200);
  },
);

/** `PROBES` (tests/invariants/probes.ts) is keyed by this `path`; the six sub-paths need no key of their own
 *  (hazard 31). */
export const bankStatementRouteModule: RouteModule = {
  path: "/v1/companies/:companyId/bank-statements",
  router: bankStatementRoutes,
  permissions: [BANK_PERMISSION.reconcile],
  auth: "human",
};
