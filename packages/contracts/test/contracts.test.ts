import { currency, Money, MoneyCurrencyMismatchError } from "@dulja/domain";
import { describe, expect, it } from "vitest";
import { AppError, ERRORS, fromDatabaseError, fromDomainError } from "../src/errors";
import {
  ListQuery,
  MoneySchema,
  QuantitySchema,
  RateSchema,
  decodeCursor,
  encodeCursor,
  parseFilters,
} from "../src/common";
import { createLogger } from "../src/logger";
import { CreateCompanyBody, UpdateCompanyBody } from "../src/admin/company";
import { CreateCurrencyBody, UpdateCurrencyBody } from "../src/admin/currency";
import { PERMISSIONS, isMutating } from "../permissions";
import { ConvertLineSchema, CreditNoteLineSchema } from "../src/accounting/invoice";
import { PaymentTermQuery } from "../src/accounting/payment-term";

const VALID_CURRENCY = {
  companyId: "0192aaaa-0000-7000-8000-000000000001",
  code: "MYR",
  nameEn: "Malaysian ringgit",
};

/** The twenty-five codes plan0B Task 3 assigns to 0B (contracts §4.2.4), in the plan's own order. */
const CODES_0B = [
  "ERR_ACTOR_IMMUTABLE",
  "ERR_AUTH_AAL_INSUFFICIENT",
  "ERR_AUTH_NO_MEMBERSHIP",
  "ERR_AUTH_TOKEN_INVALID",
  "ERR_CONFLICT_REFERENCE",
  "ERR_CONFLICT_UNIQUE",
  "ERR_DB_POOLER_URL",
  "ERR_IDEMPOTENCY_IN_FLIGHT",
  "ERR_IDEMPOTENCY_KEY_MISSING",
  "ERR_IDEMPOTENCY_KEY_REUSED",
  "ERR_INTERNAL",
  "ERR_LEDGER_UNBALANCED",
  "ERR_NOT_FOUND",
  "ERR_PERIOD_NOT_OPEN",
  "ERR_RBAC_FORBIDDEN",
  "ERR_RBAC_KIND",
  "ERR_RBAC_LAST_ADMIN",
  "ERR_RBAC_SELF_ESCALATION",
  "ERR_RBAC_SELF_GRANT",
  "ERR_RLS_DENIED",
  "ERR_ROUTE_GATE_READONLY",
  "ERR_TABLE_IMMUTABLE",
  "ERR_TENANT_CONTEXT_MISSING",
  "ERR_TENANT_CONTEXT_NESTED",
  "ERR_VALIDATION_FAILED",
] as const;

/** Later slices, each named in its own plan: 0D adds four (plan0D:22), 0C adds the edge rate limiter's one,
 *  1A adds the posting service's six (plan1A:24 — two in its Task 5, four in its Task 6), 2B adds the state
 *  machine's four (draft-only deletion, the two SoD refusals, the override door) and 2C adds one (a print
 *  template naming an engine with no adapter). */
const CODES_AFTER_0B = [
  "ERR_TILL_PIN_INVALID",
  "ERR_TILL_LIMIT_EXCEEDED",
  "ERR_TILL_CATALOGUE_STALE",
  "ERR_TILL_STORE_CORRUPT",
  // 6C — verified branch-limit refusal, allocated in contracts §4.2.4.
  "ERR_POS_LIMIT_EXCEEDED",
  "ERR_MONEY_CURRENCY_MISMATCH",
  "ERR_MONEY_SCALE",
  "ERR_RATIONAL_ZERO_DENOMINATOR",
  "ERR_RATE_NOT_FOUND",
  "ERR_RATE_LIMITED",
  "ERR_POLICY_INVALID",
  "ERR_POLICY_REQUIRES_MISSING",
  "ERR_POLICY_NOT_FOUND",
  "ERR_DOC_NO_LINES",
  "ERR_DOC_STATUS_ILLEGAL",
  "ERR_PERIOD_NOT_FOUND",
  "ERR_PERIOD_STATUS_ILLEGAL",
  "ERR_DOC_NOT_DRAFT",
  "ERR_SOD_NO_SUBMISSION",
  "ERR_SOD_MAKER_IS_CHECKER",
  "ERR_OVERRIDE_NOT_AUTHORISED",
  "ERR_PRINT_ENGINE_UNSUPPORTED",
  // 3A — the two codes Phase 3's inventory slice adds. This list is the ONE place the registry's size is
  // pinned, and it is a container-free suite, so a code added without a line here is a red build rather
  // than a silent drift (which is what happened between 3A T2/T5 and this edit).
  "ERR_WAREHOUSE_TREE_CYCLE",
  "ERR_STOCK_INSUFFICIENT",
  // 3B — the two codes the pure costing engine raises. ERR_STOCK_INSUFFICIENT above is reused by it for a
  // shortfall and for a sub-micro divisor, so the costing engine adds exactly these two names.
  "ERR_COST_NEGATIVE",
  "ERR_COST_VALUE_MISSING",
  // 3C — the one code the purchasing slice adds, raised as a token by migration 0037's
  // app.assert_document_link_within_open_quantity() and by nothing in TypeScript.
  "ERR_DOC_LINK_OVER_FULFILLED",
  // 4A — the two codes migration 0045's app.assert_credit_available() raises as tokens, landing in the same
  // commit as that migration. Distinct because a hold is not overridable and a limit is (contracts §4.8.1).
  "ERR_CREDIT_LIMIT_EXCEEDED",
  "ERR_CREDIT_HOLD",
  // 4B — the one code the bank-reconciliation slice adds (§4.2.4's allocated row), raised by packages/db's
  // BankMatchError in the same commit as migration 0050.
  "ERR_BANK_MATCH_AMOUNT",
  // Phase 5 — tax calculation and fail-closed e-invoicing.
  "ERR_TAX_REGIME_MISMATCH",
  "ERR_EINVOICE_NOT_ENABLED",
  "ERR_EINVOICE_TRANSMITTER_UNAVAILABLE",
  "ERR_EINVOICE_STATUS_ILLEGAL",
  // 6A — terminal identity and recoverable sync outcomes, including the public enrolment refusal.
  "ERR_SYNC_CURSOR_INVALID",
  "ERR_TERMINAL_SIGNATURE_INVALID",
  "ERR_TERMINAL_REVOKED",
  "ERR_SYNC_TICKET_REJECTED",
  "ERR_SYNC_MESSAGE_UNSUPPORTED",
  "ERR_TERMINAL_ENROLMENT_INVALID",
  // 7A — the one code the report engine adds (§4.2.4's allocated row), raised by packages/db's ReportError
  // from `datasetFor` in the same commit as the dataset registry.
  "ERR_REPORT_DATASET_UNKNOWN",
  // 8A — R4, no self-pay (spec:2175), raised as a token by migration 0080's app.forbid_self_pay() and landing in
  // the same commit as that migration.
  "ERR_HR_SELF_PAY",
  // 8A — verify-not-load (spec:2080), raised as a token by migration 0084's app.assert_rate_table_verifier() and
  // landing in the same commit as that migration.
  "ERR_HR_SELF_VERIFY",
  // 8B — the payroll calculator's two refusals, raised by @dulja/domain/payroll's PayrollCalculationError (A9).
  "ERR_PAYROLL_RATE_TABLE_UNVERIFIED",
  "ERR_PAYROLL_INPUT_MISSING",
  // 8C — raised as a token by migration 0091's remittance guard, landing in the same commit as that migration.
  "ERR_PAYROLL_REMITTANCE_MISMATCH",
  // 8C — raised as a token by migration 0094's "cashiers are employees" constraint trigger, in the same commit.
  "ERR_HR_CASHIER_NOT_EMPLOYEE",
  // 9A — the legacy reader's one code (§4.2.4's allocated row), raised by packages/importer's `unreadable()` in the
  // same commit as `createReader`.
  "ERR_IMPORT_SOURCE_UNREADABLE",
  // 9B — the import_batch natural-key collision (§4.2.4's allocated row, round 20 C7), raised by packages/db's
  // ImportBatchError in the same commit as migration 0102.
  "ERR_IMPORT_DUPLICATE_SOURCE_KEY",
  // 9B — the trial-balance opening's residue with no live 3900 to absorb it (§4.2.4's allocated row), raised by
  // packages/importer's openingBalanceLoader in the same commit (Task 5).
  "ERR_IMPORT_UNBALANCED_SOURCE",
  // 9B review, finding 1 — the configured legacy source bound to one tenant and company (round 20 C19), raised by
  // packages/importer's assertImportTarget in the same commit.
  "ERR_IMPORT_SOURCE_NOT_BOUND",
  // ADR 0091 (2026-11-15 review, API-03).
  "ERR_RBAC_SYSTEM_ROLE",
  "ERR_RBAC_INCOMPATIBLE_PAIR",
  // 2026-11-15 review, API-11 (ADR 0092): a body over its path's ceiling, raised by apps/edge and apps/api.
  "ERR_PAYLOAD_TOO_LARGE",
] as const;

describe("Phase 0B contracts", () => {
  // Not repeated here, because they already live in the root `tests/` workspace: the per-code title/remedy and
  // `ERR_<DOMAIN>_<REASON>` naming loop is `tests/regression/legacy-084.test.ts`, and the per-code 4xx/5xx status
  // loop is `tests/regression/legacy-083.test.ts` (which also spot-checks 0B's twenty-five names, but not the
  // later additions and not the total — both of which the next test pins).
  it("defines the complete shipped error-code subset, by name", () => {
    // plan0B Task 3 Step 2 asserted `Object.keys(ERRORS).sort()` *equals* the twenty-five 0B names. That equality
    // is wrong against the shipped registry — 0C and 0D legitimately add five more codes — so the frozen names are
    // asserted by containment, which still catches a rename or a swap, and the count is pinned alongside it so a
    // silent addition cannot slip in either.
    const codes = Object.keys(ERRORS);
    for (const code of [...CODES_0B, ...CODES_AFTER_0B]) expect(codes, code).toContain(code);
    expect(codes).toHaveLength(CODES_0B.length + CODES_AFTER_0B.length);
    expect(ERRORS.ERR_RATE_NOT_FOUND.status).toBe(422);
    expect(ERRORS.ERR_RATE_LIMITED.status).toBe(429); // 0C, raised by apps/edge
    // 2B: a second principal's authority is missing, not a state conflict — 403, not 409 (contracts §4.5.3).
    expect(ERRORS.ERR_OVERRIDE_NOT_AUTHORISED.status).toBe(403);
    expect(ERRORS.ERR_SOD_MAKER_IS_CHECKER.status).toBe(409);
    expect(ERRORS.ERR_PRINT_ENGINE_UNSUPPORTED.status).toBe(422); // 2C, raised by apps/api engineFor
    expect(ERRORS.ERR_TERMINAL_SIGNATURE_INVALID.status).toBe(401);
    expect(ERRORS.ERR_TERMINAL_REVOKED.status).toBe(403);
    expect(ERRORS.ERR_SYNC_TICKET_REJECTED.status).toBe(200);
    expect(ERRORS.ERR_SYNC_MESSAGE_UNSUPPORTED.status).toBe(200);
    expect(ERRORS.ERR_IMPORT_SOURCE_UNREADABLE.status).toBe(500); // 9A, the legacy reader; no HTTP surface
    expect(ERRORS.ERR_IMPORT_DUPLICATE_SOURCE_KEY.status).toBe(409); // 9B, a changed source under a frozen load
    expect(ERRORS.ERR_IMPORT_UNBALANCED_SOURCE.status).toBe(422); // 9B, an opening 3900 cannot absorb
    expect(ERRORS.ERR_IMPORT_SOURCE_NOT_BOUND.status).toBe(403); // 9B review, another tenant's legacy source
    expect(ERRORS.ERR_PAYLOAD_TOO_LARGE.status).toBe(413); // review API-11, the edge and the API
    expect(new AppError("ERR_NOT_FOUND", "company x absent").status).toBe(404);
  });

  it("maps a check_violation carrying a DB token to that token's code", () => {
    const e = fromDatabaseError({
      code: "23514",
      message: "ERR_RBAC_SELF_GRANT: a principal cannot change their own role assignments",
    });
    expect(e.code).toBe("ERR_RBAC_SELF_GRANT");
    expect(e.detail).toBe("a principal cannot change their own role assignments");
  });

  it("maps the SQLSTATEs contracts §4.2.4 pins, and leaves a state it does not classify at ERR_INTERNAL", () => {
    expect(fromDatabaseError({ code: "42501", message: "permission denied" }).code).toBe(
      "ERR_RLS_DENIED",
    );
    expect(fromDatabaseError({ code: "23505", message: "duplicate key" }).code).toBe(
      "ERR_CONFLICT_UNIQUE",
    );
    expect(fromDatabaseError({ code: "23503", message: "violates foreign key" }).code).toBe(
      "ERR_CONFLICT_REFERENCE",
    );
    // 22P02 used to be this clause's example and is now a 400 (the test below), so the "everything else" half
    // is pinned on a state that is still genuinely unmapped — 40001, the one the idempotency middleware's
    // retry-once comment names for exactly this reason.
    const unknown = fromDatabaseError({
      code: "40001",
      message: 'could not serialize access due to concurrent update of "app.principal"',
    });
    expect(unknown.code).toBe("ERR_INTERNAL");
    expect(unknown.detail).not.toContain("app.principal"); // never echo the driver's text (LEGACY-083)
    expect(unknown.extra?.sqlstate).toBe("40001"); // …but keep it for the log line
  });

  // A pagination cursor is base64url, not signed, and `decodeCursor` can only check its shape — so a caller can
  // hand any text to the `::text::timestamptz`, `::uuid` and `::bigint` casts the list routes apply to it. Each
  // message below is the one postgres:18 actually produced for a value such a cursor can carry. Client input
  // must not answer 5xx: it misleads the caller and spends an error budget an operator watches.
  it("maps a bound value that would not parse as its cast type to 400, not 500", () => {
    const states: Record<string, string> = {
      "22P02": 'invalid input syntax for type uuid: "nope"',
      "22007": 'invalid input syntax for type timestamp with time zone: "not-a-date"',
      "22008": 'date/time field value out of range: "2024-13-01"',
      "22009": 'time zone displacement out of range: "2024-01-01T00:00:00+99"',
      "22003": 'value "99999999999999999999" is out of range for type bigint',
    };
    for (const [state, message] of Object.entries(states)) {
      const e = fromDatabaseError({ code: state, message });
      expect(e.code, state).toBe("ERR_VALIDATION_FAILED");
      expect(e.status, state).toBe(400);
      expect(e.extra?.sqlstate, state).toBe(state); // still on the log line, so a real defect is not hidden
      // never echo the driver's text (LEGACY-083) — it quotes the rejected value straight back
      expect(e.detail, state).not.toMatch(/nope|not-a-date|2024-13-01|\+99|99999999999999999999/);
    }
  });

  it("keeps the class-22 states that mean a server bug at ERR_INTERNAL", () => {
    // Division by zero, a logarithm's argument domain and a null where none is allowed are all reached through
    // arithmetic this codebase wrote; 22001 fires on a value being stored, not parsed; 22P03 is a driver fault.
    for (const state of ["22012", "2201E", "22004", "22001", "22P03"])
      expect(fromDatabaseError({ code: state, message: "x" }).code, state).toBe("ERR_INTERNAL");
  });

  it("a check_violation with no token is ERR_INTERNAL, not a silently swallowed success (LEGACY-083)", () => {
    expect(
      fromDatabaseError({ code: "23514", message: 'new row violates check constraint "chk_x"' })
        .code,
    ).toBe("ERR_INTERNAL");
  });

  it("refuses a zero POS rounding increment and an unknown time zone at the contract", () => {
    expect(
      CreateCurrencyBody.safeParse({ ...VALID_CURRENCY, posRoundingIncrement: "0.0000" }).success,
    ).toBe(false);
    expect(
      CreateCurrencyBody.safeParse({ ...VALID_CURRENCY, posRoundingIncrement: "0.0500" }).success,
    ).toBe(true);
    expect(UpdateCurrencyBody.safeParse({ posRoundingIncrement: "00.0000" }).success).toBe(false);
    expect(
      CreateCompanyBody.safeParse({
        code: "X",
        name: "X",
        baseCurrency: "MYR",
        timezone: "Mars/Olympus",
      }).success,
    ).toBe(false);
    expect(
      CreateCompanyBody.safeParse({
        code: "X",
        name: "X",
        baseCurrency: "MYR",
        timezone: "Asia/Kuala_Lumpur",
      }).success,
    ).toBe(true);
    expect(UpdateCompanyBody.safeParse({ timezone: "Europe/Nowhere" }).success).toBe(false);
  });

  it("keeps wire money precise and pagination opaque", () => {
    expect(MoneySchema.safeParse({ amount: "1.0000", currency: "MYR" }).success).toBe(true);
    expect(MoneySchema.safeParse({ amount: "-1.0000", currency: "MYR" }).success).toBe(true);
    expect(MoneySchema.safeParse({ amount: "1234.50", currency: "MYR" }).success).toBe(false);
    expect(MoneySchema.safeParse({ amount: 1, currency: "MYR" }).success).toBe(false);
    expect(MoneySchema.safeParse({ amount: "1.0000", currency: "myr" }).success).toBe(false);
    expect(QuantitySchema.safeParse("1.000000").success).toBe(true);
    expect(QuantitySchema.safeParse("12.0000").success).toBe(false);
    expect(RateSchema.safeParse("1.00000000").success).toBe(true);
    expect(RateSchema.safeParse("4.68").success).toBe(false);
    expect(ListQuery.parse({})).toEqual({ limit: 100 });
    expect(ListQuery.safeParse({ limit: "1001" }).success).toBe(false);
    const cursor = encodeCursor({ k: ["a"], id: "b" });
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(cursor)).toEqual({ k: ["a"], id: "b" });
    expect(() => decodeCursor("!!!not-base64!!!")).toThrow(/ERR_VALIDATION_FAILED/);
    expect(() => decodeCursor(Buffer.from("[]").toString("base64url"))).toThrow(
      /ERR_VALIDATION_FAILED/,
    );
    // The audit log, roles and companies all encode an empty keyset, so `[]` has to survive the round trip…
    expect(decodeCursor(encodeCursor({ k: [], id: "b" }))).toEqual({ k: [], id: "b" });
    // …while a `k` entry no route could have written, and an empty `id`, are hand-crafted and refused here
    // rather than at the cast, where they used to become a 500.
    expect(() => decodeCursor(encodeCursor({ k: [{}], id: "b" }))).toThrow(/ERR_VALIDATION_FAILED/);
    expect(() => decodeCursor(encodeCursor({ k: ["a"], id: "" }))).toThrow(/ERR_VALIDATION_FAILED/);
  });

  it("emits structured logs and drops secrets", () => {
    const lines: string[] = [];
    const logger = createLogger({ sink: (line) => lines.push(line) });
    logger.info({ authorization: "Bearer secret", request_id: "r" }, "finished");
    expect(lines).toHaveLength(2);
    expect(lines.join("")).not.toContain("Bearer secret");
  });

  it("child() presets fields on every later call", () => {
    const lines: string[] = [];
    createLogger({ sink: (line) => lines.push(line) })
      .child({ request_id: "r1" })
      .warn({ path: "/v1/companies" }, "slow");
    expect(JSON.parse(lines[0]!)).toMatchObject({
      level: "warn",
      request_id: "r1",
      path: "/v1/companies",
    });
  });

  it("respects the level floor", () => {
    const lines: string[] = [];
    const log = createLogger({ sink: (line) => lines.push(line), level: "warn" });
    log.debug({}, "d");
    log.info({}, "i");
    log.warn({}, "w");
    log.error({}, "e");
    expect(lines.map((line) => (JSON.parse(line) as { level: string }).level)).toEqual([
      "warn",
      "error",
    ]);
  });

  it("parses only the declared filter grammar", () => {
    expect(parseFilters({ "filter[status][eq]": "open", limit: "10" })).toEqual([
      { field: "status", op: "eq", value: "open" },
    ]);
    expect(() => parseFilters({ "filter[status][sql]": "drop" })).toThrow(/ERR_VALIDATION_FAILED/);
  });
});

describe("fromDomainError — lifting a @dulja/domain throw into the API envelope (0D)", () => {
  it("maps a domain error whose code is in the registry", () => {
    const err = new MoneyCurrencyMismatchError("MYR", "USD");
    const app = fromDomainError(err);
    expect(app).toBeInstanceOf(AppError);
    expect(app!.code).toBe("ERR_MONEY_CURRENCY_MISMATCH");
    expect(app!.detail).toBe("cannot combine MYR with USD");
    expect(ERRORS.ERR_MONEY_CURRENCY_MISMATCH.status).toBe(422);
  });

  it("returns null for anything else, so the caller rethrows untouched", () => {
    expect(fromDomainError(new Error("boom"))).toBeNull();
    expect(fromDomainError({ code: "ERR_NOT_IN_REGISTRY" })).toBeNull();
    expect(fromDomainError(null)).toBeNull();
  });

  it("ERR_MONEY_CURRENCY_INVALID is deliberately NOT in the registry (contracts §4.2.4)", () => {
    expect("ERR_MONEY_CURRENCY_INVALID" in ERRORS).toBe(false);
    expect(fromDomainError(new Error("x"))).toBeNull();
    expect(() => currency("myr")).toThrow(/ERR_MONEY_CURRENCY_INVALID/);
    expect(Money.of("1", currency("MYR")).toString()).toBe("1.0000");
  });
});

/**
 * The catalogue half of slice 3D Task 2. `packages/db` may import `@dulja/contracts` from exactly one file
 * (0B's `dependency-rule` ALLOW set names `permission-catalogue.test.ts`, where the both-directions equality
 * between `app.permission` and `PERMISSIONS` is asserted against a live database), so the assertion that this
 * slice's six rows are present, mutating, and tagged with its own slice id lives here — where it runs without
 * a container.
 */
const moduleOf = (code: string): string => PERMISSIONS.find((entry) => entry.code === code)!.module;

describe("slice 3D permission catalogue rows (contracts §3.6.2)", () => {
  const CODES_3D = [
    "inventory.transfer.create",
    "inventory.transfer.post",
    "inventory.count.create",
    "inventory.adjustment.create",
    "inventory.adjustment.approve",
    "accounting.sales.create",
  ] as const;

  it("carries all six, every one mutating and phased 3D", () => {
    for (const code of CODES_3D) {
      const def = PERMISSIONS.find((entry) => entry.code === code);
      expect(def, `packages/contracts/permissions.ts has no row for ${code}`).toBeDefined();
      expect(def!.mutating, code).toBe(true);
      expect(def!.phase, code).toBe("3D");
      expect(isMutating(def!.code), code).toBe(true);
    }
  });

  it("puts five in the inventory module and the sales code in accounting (§3.6.1's closed module list)", () => {
    expect(moduleOf("accounting.sales.create")).toBe("accounting");
    for (const code of CODES_3D.filter((candidate) => candidate !== "accounting.sales.create"))
      expect(moduleOf(code), code).toBe("inventory");
  });
});

describe("Phase 4 review S6 — the 4A line and query schemas refuse unknown keys", () => {
  const id = "01a0e942-834f-7e6d-9a37-e2d17a47b6b4";
  it("ConvertLineSchema and CreditNoteLineSchema are strict", () => {
    expect(ConvertLineSchema.safeParse({ sourceLineId: id, quantity: "1.000000" }).success).toBe(
      true,
    );
    expect(
      ConvertLineSchema.safeParse({ sourceLineId: id, quantity: "1.000000", unitPrice: "0.0100" })
        .success,
    ).toBe(false);
    expect(
      CreditNoteLineSchema.safeParse({ settledLineId: id, quantity: "1.000000" }).success,
    ).toBe(true);
    expect(
      CreditNoteLineSchema.safeParse({ settledLineId: id, quantity: "1.000000", cost: "0.0000" })
        .success,
    ).toBe(false);
  });
  it("PaymentTermQuery is strict", () => {
    expect(PaymentTermQuery.safeParse({ "filter[archived][eq]": "true" }).success).toBe(true);
    expect(PaymentTermQuery.safeParse({ "filter[code][eq]": "N30" }).success).toBe(false);
  });
});
