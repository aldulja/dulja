export interface ErrorDef {
  readonly status: number;
  readonly title: string;
  readonly remedy: string;
}
const def = (status: number, title: string, remedy: string) => ({ status, title, remedy });
export const ERRORS = {
  ERR_TILL_PIN_INVALID: {
    status: 401,
    title: "Cashier PIN invalid",
    remedy:
      "Enter the cashier employee number and PIN again, or ask the branch manager to reset the credential.",
  },
  ERR_TILL_LIMIT_EXCEEDED: {
    status: 422,
    title: "Till limit exceeded",
    remedy: "Ask a supervisor to authorise this action or reduce it to the allowed branch limit.",
  },
  ERR_TILL_CATALOGUE_STALE: {
    status: 409,
    title: "Till catalogue unavailable",
    remedy: "Connect the till and complete a catalogue update before pricing a ticket.",
  },
  ERR_TILL_STORE_CORRUPT: {
    status: 500,
    title: "Till store unavailable",
    remedy:
      "Preserve the local database and contact support to recover unsent tickets before re-enrolling.",
  },
  ERR_POS_LIMIT_EXCEEDED: {
    status: 422,
    title: "POS limit exceeded",
    remedy:
      "Ask a supervisor to authorise the discount, void or blind return, or raise the branch limit under admin.company.manage.",
  },
  ERR_SYNC_CURSOR_INVALID: {
    status: 400,
    title: "Sync cursor invalid",
    remedy: "Start catalogue sync again using a cursor returned by this server.",
  },
  ERR_TERMINAL_SIGNATURE_INVALID: {
    status: 401,
    title: "Terminal signature invalid",
    remedy: "Check the till clock and terminal enrolment, then sign the request again.",
  },
  ERR_TERMINAL_REVOKED: {
    status: 403,
    title: "Terminal revoked",
    remedy: "Ask the back office to enrol an authorised replacement terminal.",
  },
  ERR_SYNC_TICKET_REJECTED: {
    status: 200,
    title: "Ticket rejected",
    remedy:
      "Open the ticket in the shop's needs-attention queue; the whole payload and the reason are there.",
  },
  ERR_SYNC_MESSAGE_UNSUPPORTED: {
    status: 200,
    title: "Message not supported yet",
    remedy: "Keep the outbox row and re-send; this server build does not apply this message kind.",
  },
  ERR_TERMINAL_ENROLMENT_INVALID: {
    status: 400,
    title: "Terminal enrolment invalid",
    remedy: "Ask the back office to issue a new enrolment code and enrol the terminal again.",
  },

  ERR_EINVOICE_NOT_ENABLED: {
    status: 422,
    title: "E-invoicing is not enabled",
    remedy:
      "Set the company's e-invoice transmitter, client id and credential reference under Company settings.",
  },
  ERR_EINVOICE_TRANSMITTER_UNAVAILABLE: {
    status: 422,
    title: "E-invoice transmitter unavailable",
    remedy:
      "Check that the transmitter is registered in this deployment and that its credential secret is set.",
  },
  ERR_EINVOICE_STATUS_ILLEGAL: {
    status: 409,
    title: "Transmission status does not permit this action",
    remedy:
      "Read the transmission's current status; submit, poll and cancel are each legal only from their own states.",
  },

  ERR_TAX_REGIME_MISMATCH: {
    status: 422,
    title: "Tax code does not belong to this regime",
    remedy:
      "Use a tax code of the document's tax regime, or select the regime the code belongs to.",
  },

  ERR_VALIDATION_FAILED: def(400, "Request failed validation", "Correct the listed fields."),
  ERR_IDEMPOTENCY_KEY_MISSING: def(
    400,
    "Idempotency-Key header required",
    "Send an Idempotency-Key header.",
  ),
  ERR_MONEY_SCALE: def(
    400,
    "Amount is not a valid money value",
    'Send the amount as a decimal string with at most four decimal places, e.g. "1234.5000".',
  ),
  ERR_RATIONAL_ZERO_DENOMINATOR: def(
    400,
    "Unit conversion has a zero denominator",
    "Give the conversion as numerator/denominator with a non-zero denominator.",
  ),
  ERR_AUTH_TOKEN_INVALID: def(401, "Access token invalid", "Sign in again."),
  ERR_AUTH_AAL_INSUFFICIENT: def(401, "Multi-factor authentication required", "Enrol MFA."),
  ERR_AUTH_NO_MEMBERSHIP: def(403, "No membership", "Ask an administrator for an invitation."),
  ERR_RBAC_FORBIDDEN: def(403, "Permission denied", "Ask an administrator for access."),
  ERR_RLS_DENIED: def(403, "Row is outside this tenant", "Check the request identifiers."),
  ERR_NOT_FOUND: def(404, "Resource not found", "Check the identifier."),
  ERR_RATE_LIMITED: def(429, "Too Many Requests", "Wait for the RateLimit-Reset window and retry."),
  // API-11 (ADR 0092): a request body over its path's ceiling — raised by the edge (apps/edge/src/router.ts) and by
  // the API's defence-in-depth limit (apps/api/src/middleware/body-limit.ts).
  ERR_PAYLOAD_TOO_LARGE: def(413, "Payload Too Large", "Send a smaller request body."),
  ERR_RBAC_SELF_GRANT: def(409, "Self grant prohibited", "Ask another administrator."),
  ERR_RBAC_SELF_ESCALATION: def(409, "Self escalation prohibited", "Ask another administrator."),
  ERR_RBAC_KIND: def(409, "Role and principal kind do not match", "Use a compatible role."),
  // ADR 0091 (2026-11-15 review, API-03): a seeded role changes only by migration (spec:2152); migration 0124.
  ERR_RBAC_SYSTEM_ROLE: def(
    409,
    "System role cannot be changed",
    "Clone the role into a custom role and change that; a system role changes only by migration.",
  ),
  // ADR 0091: R6's incompatible pairs (spec:2177), applied to a custom role's resulting permission set.
  ERR_RBAC_INCOMPATIBLE_PAIR: def(
    409,
    "Role would hold an incompatible pair",
    "Split the two permissions across two roles; R6 keeps them apart.",
  ),
  ERR_RBAC_LAST_ADMIN: def(
    409,
    "Last administrator cannot be removed",
    "Assign another administrator first.",
  ),
  ERR_ACTOR_IMMUTABLE: def(409, "Actor cannot be rewritten", "Create a correcting record."),
  // 8A — R4 (spec:2175, SAH-045): raised by migration 0080's app.forbid_self_pay() on the four HR write targets.
  ERR_HR_SELF_PAY: def(
    409,
    "Self-pay refused",
    "Ask another principal holding the HR permission to make this change; R4 forbids acting on your own HR record.",
  ),
  ERR_HR_SELF_VERIFY: def(
    409,
    "Verification refused",
    "A statutory rate table is verified by a principal other than the one who loaded it; ask the accountant. A table that is already verified is frozen — load a new version instead of editing it.",
  ),
  // 8B — the payroll calculator's two refusals (§4.2.4's allocated rows), raised by @dulja/domain/payroll's
  // PayrollCalculationError (amendment A9) in the same commit as this row.
  ERR_PAYROLL_RATE_TABLE_UNVERIFIED: def(
    422,
    "Rate table not usable",
    "Have a principal other than the one who loaded it verify the table (hr.statutory_table.verify), or load a version whose effective range covers the whole pay period.",
  ),
  ERR_PAYROLL_INPUT_MISSING: def(
    422,
    "Statutory input missing",
    "Complete the named employee's statutory profile or compensation line and recalculate the run. The run never substitutes a zero.",
  ),
  // 8C — raised by migration 0091's app.assert_remittance_matches_schedule() (round 18 B1), in the same commit.
  ERR_PAYROLL_REMITTANCE_MISMATCH: def(
    422,
    "Remittance does not match the schedule",
    "Pay exactly the schedule's employee plus employer total, or regenerate the schedule from the posted run before settling it.",
  ),
  // 8C — raised as a token by migration 0094's app.assert_cashier_is_employee() (round 18 B13), in the same commit.
  ERR_HR_CASHIER_NOT_EMPLOYEE: def(
    409,
    "Cashier is not an active employee",
    "Reinstate the employee before restoring the till credential, or leave the credential revoked.",
  ),
  ERR_TABLE_IMMUTABLE: def(409, "Row is append-only", "Post a correction instead."),
  ERR_IDEMPOTENCY_KEY_REUSED: def(409, "Idempotency key reused", "Use a fresh key."),
  ERR_IDEMPOTENCY_IN_FLIGHT: def(409, "Request is in flight", "Retry shortly."),
  // 9A — §4.2.4's allocated row ("Firebird reader (9A)"), added in the commit that raises it: `unreadable()` in
  // packages/importer/src/legacy/types.ts. No HTTP surface carries it; the legacy CLI maps it to exit code 3.
  ERR_IMPORT_SOURCE_UNREADABLE: def(
    500,
    "The legacy source could not be read",
    "Check the ODBC DSN and the Firebird engine version, then re-run the extraction (ADR 0081).",
  ),
  // 9B — §4.2.4's allocated row ("import_batch natural-key collision (9B)"), added in the commit that raises it:
  // `ImportBatchError` in packages/db/src/import/batch.ts. A re-run against CHANGED source data (round 20 C7).
  ERR_IMPORT_DUPLICATE_SOURCE_KEY: def(
    409,
    "Legacy key already imported with different data",
    "The source row changed since it was first loaded. Freeze the source, then re-run. A recorded row is never imported again, a reversal included: correct what it became with an ordinary document, or re-import into a fresh company.",
  ),
  // 9B — §4.2.4's second allocated row, added in the commit that raises it: `openingBalanceLoader.load` in
  // packages/importer/src/load/opening-balance.ts, when the trial-balance opening leaves a residue and 3900 cannot take it.
  ERR_IMPORT_UNBALANCED_SOURCE: def(
    422,
    "Legacy figures do not balance",
    "Run the 9A unbalanced-voucher report, agree the suspense treatment (account 3900) with the customer, then re-run the load.",
  ),
  // 9B review (finding 1; contracts §3.11, round 20 C19) — the legacy source a deployment configures is bound to ONE
  // tenant and company (`LEGACY_IMPORT_TARGET`); a run of any other is refused before the source is opened, by
  // packages/importer's `assertImportTarget` (the worker's run failure and the CLI's exit 2).
  ERR_IMPORT_SOURCE_NOT_BOUND: def(
    403,
    "Legacy source not bound to this company",
    "Bind LEGACY_IMPORT_TARGET=<tenantId>:<companyId> beside LEGACY_ODBC_DSN for this company's cut-over only, or load from the importer CLI with an explicit --dsn (docs/runbooks/cut-over.md).",
  ),
  ERR_CONFLICT_UNIQUE: def(409, "Unique conflict", "Change the unique value."),
  ERR_CONFLICT_REFERENCE: def(409, "Reference conflict", "Create or release the referenced row."),
  ERR_LEDGER_UNBALANCED: def(422, "Debits do not equal credits", "Balance the document."),
  ERR_MONEY_CURRENCY_MISMATCH: def(
    422,
    "Currency mismatch",
    "Convert one amount to the other currency with an exchange rate before combining them.",
  ),
  ERR_PERIOD_NOT_OPEN: def(422, "Fiscal period is not open", "Use an open period."),
  ERR_POLICY_NOT_FOUND: def(
    422,
    "No posting policy",
    "Seed a posting policy for this document type effective on or before the document's effective date.",
  ),
  ERR_DOC_NO_LINES: def(
    422,
    "Document has no lines",
    "Add at least one line with a non-zero debit or credit, then post again.",
  ),
  ERR_DOC_STATUS_ILLEGAL: def(
    409,
    "Illegal document transition",
    "Check the document's current status; a posted document is corrected by reversal, never by editing.",
  ),
  ERR_PERIOD_STATUS_ILLEGAL: def(
    409,
    "Illegal fiscal-period transition",
    "Check the period's current status: only an open period is closed, and only a closed or locked one is reopened.",
  ),
  ERR_PERIOD_NOT_FOUND: def(
    422,
    "No fiscal period",
    "Create the fiscal period covering this effective date, or correct the date.",
  ),
  ERR_POLICY_INVALID: def(
    422,
    "Posting policy invalid",
    "Correct the policy definition in the seed pack and re-run the document-types seed for this tenant.",
  ),
  ERR_POLICY_REQUIRES_MISSING: def(
    422,
    "Posting policy input missing",
    "Supply the field, dimension or account the message names, then post again.",
  ),
  ERR_RATE_NOT_FOUND: def(
    422,
    "No exchange rate is effective on that date",
    "Enter an exchange rate for the currency pair with an effective date on or before the document date.",
  ),
  // 2B — raised by app.forbid_delete_unless_draft / app.forbid_line_delete_unless_draft (migration 0023).
  ERR_DOC_NOT_DRAFT: def(
    409,
    "Document is not a draft",
    "Only a draft may be deleted; an issued document is voided and a posted one is reversed (spec:2049, 2224).",
  ),
  // 2B — raised by app.document_status_before (migration 0022): R1, maker <> checker (spec:2172).
  ERR_SOD_NO_SUBMISSION: def(
    409,
    "No submission on record",
    "The document type requires a maker before a checker: submit the document first, then have a second principal approve it.",
  ),
  ERR_SOD_MAKER_IS_CHECKER: def(
    409,
    "Maker cannot be checker",
    "The principal who submitted a document cannot approve or post it; ask a second principal.",
  ),
  // 2B — raised by app.assert_override_authorised (migration 0021), the override door of contracts §4.5.3 (R8).
  ERR_OVERRIDE_NOT_AUTHORISED: def(
    403,
    "Override not authorised",
    "An override needs a SECOND principal who holds the override permission at the document's branch; ask a supervisor.",
  ),
  // 3A — raised as a token by app.warehouse_no_cycle() (migration 0029), the ONE recursive-CTE tree
  // guard of SAH-071. A state conflict, not a malformed request: the body is well-formed and the
  // parent it names simply cannot be this warehouse's, so 409 rather than ERR_VALIDATION_FAILED.
  ERR_WAREHOUSE_TREE_CYCLE: def(
    409,
    "Warehouse tree cycle",
    "Choose a parent warehouse that is not this warehouse or one of its descendants.",
  ),
  // 3A — raised as a token by app.assert_stock_available() (migration 0031), the BEFORE INSERT trigger on
  // app.inventory_movement that makes acceptance test 18 true by API, by job and by raw app_rw SQL alike.
  // 422 and not 409: §4.2.4's allocated table fixes the status and marks the code ¶ (the spec names it).
  ERR_STOCK_INSUFFICIENT: def(
    422,
    "Insufficient stock",
    "Reduce the quantity, pick a different lot or warehouse, or have a second principal record an inventory.negative_stock.override on this document.",
  ),
  // 3B — the two codes the pure costing engine raises (packages/domain/src/costing/engine.ts). Both are 422:
  // the request is well-formed and the state is legal, but the movement cannot be costed without storing a
  // number SAH-007/SAH-008 forbid. ERR_COST_VALUE_MISSING covers BOTH arms the engine raises it for — a
  // movement with no value (SAH-007) and a movement of zero quantity (SAH-008(c)) — deliberately, because a
  // remedy naming only the unit price would point a user at the wrong field on a wash line.
  ERR_COST_NEGATIVE: def(
    422,
    "Computed cost is negative",
    "A negative unit cost cannot be stored. Check the returned quantity and value on the movement that produced it.",
  ),
  ERR_COST_VALUE_MISSING: def(
    422,
    "Stock movement cannot be costed",
    "A stock movement needs a non-zero quantity and a value. Give the line a quantity and a unit price, or allocate a landed cost to it, before posting.",
  ),
  // 3C — raised as a token by app.assert_document_link_within_open_quantity() (migration 0037), the BEFORE
  // INSERT OR UPDATE trigger on app.document_link. 422 and not 409: §4.2.4's allocated table fixes the
  // status. The request is well-formed and the order's state is legal — the quantity asked for is simply
  // larger than what is left open, which is a figure the caller can read before retrying.
  ERR_DOC_LINK_OVER_FULFILLED: def(
    422,
    "Over-fulfilled",
    "Reduce the quantity on this line, or check the order's remaining open quantity at GET /v1/companies/{companyId}/documents/{documentId}/open-quantity.",
  ),
  // 4A — the two codes raised as tokens by app.assert_credit_available() (migration 0045), the second BEFORE
  // UPDATE OF status trigger on app.document. Two codes, not one, because the remedies differ: a limit is
  // raised or overridden by a second principal, while a hold is released and NO override lifts it
  // (contracts §4.8.1 "blocks regardless"). 422: the request is well-formed; the party's state refuses it.
  ERR_CREDIT_LIMIT_EXCEEDED: def(
    422,
    "Credit limit exceeded",
    "Raise the customer's credit limit, or have a second principal holding accounting.credit_limit.override record an override on this document.",
  ),
  ERR_CREDIT_HOLD: def(
    422,
    "Customer is on credit hold",
    "Release the customer's credit hold. An override does not lift a hold.",
  ),
  // 4B — §4.2.4's allocated row, added in the PR that raises it: packages/db's BankMatchError (Task 7's
  // match/unmatch/reconciledBalance). 422: the request is well-formed; the line, the document and the amount
  // disagree — in direction, in currency, or in what is left to match on either side.
  ERR_BANK_MATCH_AMOUNT: def(
    422,
    "Bank match amounts do not agree",
    "Match an amount no greater than the statement line's and the document's remaining balance, and match money in against money in.",
  ),
  // 2C — raised by apps/api's engineFor when a print_template row names an engine with no adapter.
  ERR_PRINT_ENGINE_UNSUPPORTED: def(
    422,
    "Print engine unsupported",
    "Choose a print template whose engine renders template text (see ADR 0016 and ADR 0032).",
  ),
  // 7A — §4.2.4's allocated row, added in the PR that raises it: packages/db's ReportError (datasetFor). 422:
  // the definition is well-formed JSON whose dataset.source names no member of the closed registry (§4.16.2).
  ERR_REPORT_DATASET_UNKNOWN: def(
    422,
    "Unknown report dataset",
    "Name a dataset from the registry the error lists, or ask for the report definition to be corrected.",
  ),
  ERR_TENANT_CONTEXT_MISSING: def(500, "Tenant context missing", "Report the request id."),
  ERR_TENANT_CONTEXT_NESTED: def(500, "Nested tenant transaction", "Report the request id."),
  ERR_DB_POOLER_URL: def(500, "Transaction pooler URL", "Use port 5432."),
  ERR_ROUTE_GATE_READONLY: def(500, "Invalid route gate", "Report the request id."),
  ERR_INTERNAL: def(500, "Unexpected server error", "Report the request id."),
} as const satisfies Record<string, ErrorDef>;
export type ErrCode = keyof typeof ERRORS;
export interface Problem {
  type: `urn:dulja:error:${ErrCode}`;
  title: string;
  status: number;
  detail: string;
  instance: string;
  code: ErrCode;
  remedy: string;
  requestId: string;
  errors?: { path: string; message: string }[];
}
export class AppError extends Error {
  constructor(
    readonly code: ErrCode,
    readonly detail: string,
    readonly extra?: Partial<Problem> & { sqlstate?: string },
  ) {
    super(`${code}: ${detail}`);
    this.name = "AppError";
  }
  get status() {
    return ERRORS[this.code].status;
  }
}
/**
 * Class 22 (data exception) states that, on every path this codebase can reach today, mean "the *text of a bound
 * value* would not parse as, or would not fit, the type the query casts it to". Every bound value is
 * client-supplied, because no SQL here is concatenated, so each is bad input rather than a server bug. All five
 * are reachable from a hand-crafted pagination cursor — it is base64url, not signed, and `decodeCursor` can only
 * check its shape: `::text::timestamptz` on `k[0]` raises 22007, 22008 or 22009, `::uuid` on `id` raises 22P02,
 * and the audit log's `::bigint` on `id` raises 22P02 or 22003. Each was reproduced against postgres:18.
 *
 * The cost: a genuine server-side defect landing on one of these now reports 400, not 500. For 22P02, 22007 and
 * 22009 that is close to free — each needs a *string* to fail on, and every string this codebase hands Postgres
 * is a bound request value. 22008 and 22003 are the loose two: datetime and numeric arithmetic overflow into them
 * with no string at all. Nothing reachable in Phase 0 does that arithmetic, both are needed — drop 22003 and the finding
 * reopens through the audit log's `::bigint` on `{"k":[],"id":"9…9"}` — and the SQLSTATE still reaches the log
 * line, so a defect that does land here is hidden from the error budget, not from the operator. When Plan 1A
 * sums numeric(38,4) in the posting service, revisit: the answer then is for it to raise its own token before
 * Postgres overflows (the pattern 7A took), not to drop this entry and reopen the 500.
 *
 * Deliberately left at ERR_INTERNAL: 22012 division_by_zero and the argument-domain states (2201E, 2201F …),
 * which a client value reaches only through arithmetic this codebase wrote; 22001 string_data_right_truncation,
 * which fires on a value being stored rather than parsed; 22P03 invalid_binary_representation, a driver or
 * protocol fault; and 22025/2201B, which need a client-supplied LIKE or regex pattern — `parseFilters` builds
 * one but nothing feeds it to SQL yet, so mapping them now would be speculative.
 */
const BAD_INPUT_STATES = new Set(["22P02", "22007", "22008", "22009", "22003"]);

export function fromDatabaseError(error: unknown): AppError {
  const e = error as { code?: unknown; message?: unknown };
  const state = typeof e.code === "string" ? e.code : undefined;
  const message = typeof e.message === "string" ? e.message : "";
  if (state === "23514") {
    const match = /^(ERR_[A-Z0-9_]+): (.*)$/s.exec(message);
    if (match?.[1] && match[1] in ERRORS) return new AppError(match[1] as ErrCode, match[2] ?? "");
  }
  const mapped: Record<string, ErrCode> = {
    "42501": "ERR_RLS_DENIED",
    "23505": "ERR_CONFLICT_UNIQUE",
    "23503": "ERR_CONFLICT_REFERENCE",
  };
  const extra = state ? { sqlstate: state } : {};
  // The detail is fixed rather than derived from the driver's, which quotes the rejected value straight back
  // (SAH-083) — and this is the one branch whose text a caller will actually read.
  if (state && BAD_INPUT_STATES.has(state))
    return new AppError(
      "ERR_VALIDATION_FAILED",
      "a value in the request could not be read as the type it is used as",
      extra,
    );
  return new AppError(
    mapped[state ?? ""] ?? "ERR_INTERNAL",
    state && mapped[state]
      ? "the database rejected this request"
      : "the request could not be completed",
    extra,
  );
}

/**
 * `packages/domain` may not import this module (§5.2 dependency rule: domain imports nothing internal), so its errors
 * carry a `code` string instead of extending AppError. This is the one place that lifts such a throw into an AppError.
 * Returns null for anything that is not a recognised domain error, so a caller can rethrow untouched.
 */
export function fromDomainError(e: unknown): AppError | null {
  if (typeof e !== "object" || e === null || !("code" in e)) return null;
  const code = (e as { code: unknown }).code;
  if (typeof code !== "string" || !(code in ERRORS)) return null;
  const detail = e instanceof Error ? e.message.replace(/^ERR_[A-Z_]+: /, "") : code;
  return new AppError(code as ErrCode, detail);
}
