import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import {
  AppError,
  CreatePartyBody,
  decodeCursor,
  encodeCursor,
  PartyBalanceQuery,
  PartyBalanceSchema,
  PartyList,
  PartyQuery,
  PartySchema,
  ProblemSchema,
  UpdatePartyBody,
  UuidSchema,
} from "@dulja/contracts";
import { PERMISSION } from "@dulja/contracts/permissions";
import { partyBalance } from "@dulja/db";
import type { AppEnv } from "../../context";
import { requirePermission } from "../../middleware/require-permission";
import { IdempotencyHeader } from "../idempotency-header";

/**
 * `/v1/companies/{companyId}/parties` under `accounting.party.manage` (contracts §3.6.2, spec:2159). Parties
 * are master data: created, edited, ARCHIVED, never deleted (spec:2049). There is deliberately no DELETE
 * route and no DELETE grant: contracts §3.5.4 pins the grant list and 2B is the only slice that extends it.
 *
 * 4A adds the customer's commercial terms (migration 0045, contracts §4.5.7): `creditLimit`, `paymentTermId`,
 * `creditHold` and `priceListId`. One of them, `creditLimit`, needs a second code — see
 * `assertMayWriteCreditLimit` below.
 */
export const partyRoutes = new OpenAPIHono<AppEnv>({
  defaultHook: (result) => {
    if (!result.success) throw result.error;
  },
});
const gate = () =>
  requirePermission(PERMISSION["accounting.party.manage"], { company: "path:companyId" });

interface PartyRow {
  id: string;
  kind: string;
  code: string;
  name_en: string;
  name_ar: string | null;
  receivable_account_id: string | null;
  payable_account_id: string | null;
  currency: string | null;
  tax_registration: string | null;
  email: string | null;
  phone: string | null;
  address: Record<string, unknown>;
  archived_at: Date | null;
  created_at: Date;
  // 4A / 0045. `base_currency` is the company's, read beside the row: `credit_limit` has no currency
  // column of its own because it is always in base (app.party_open_balance compares in base).
  credit_limit: string | null;
  payment_term_id: string | null;
  credit_hold: boolean;
  price_list_id: string | null;
  base_currency: string;
}
const toDto = (row: PartyRow) => ({
  id: row.id,
  kind: row.kind as "customer" | "vendor" | "employee" | "student" | "dealer",
  code: row.code,
  nameEn: row.name_en,
  nameAr: row.name_ar,
  receivableAccountId: row.receivable_account_id,
  payableAccountId: row.payable_account_id,
  currency: row.currency?.trim() ?? null,
  taxRegistration: row.tax_registration,
  email: row.email,
  phone: row.phone,
  address: row.address,
  archivedAt: row.archived_at?.toISOString() ?? null,
  createdAt: row.created_at.toISOString(),
  creditLimit:
    row.credit_limit === null
      ? null
      : { amount: row.credit_limit, currency: row.base_currency.trim() },
  paymentTermId: row.payment_term_id,
  creditHold: row.credit_hold,
  priceListId: row.price_list_id,
});

type Tx = Parameters<Parameters<AppEnv["Variables"]["withTenant"]>[0]>[0];

/**
 * The column list the five statements below return. A nested postgres.js fragment — the shape
 * `documents.ts`'s `header(tx)` and `payment-term.ts`'s `COLUMNS(tx)` use — never a string and never
 * `tx.unsafe(...)`: contracts §3.3 gives `sql.unsafe` exactly three homes and none of them is here, and the
 * `no-sql-concat` lint (test 27) is what keeps SAH-036/037/069 closed. 2A wrote the list out five times; 4A's
 * four columns and the company's base currency made that five copies of a two-line list, so it is one.
 */
const COLUMNS = (tx: Tx) =>
  tx`id, kind, code, name_en, name_ar, receivable_account_id, payable_account_id, currency,
     tax_registration, email, phone, address, archived_at, created_at,
     credit_limit::text as credit_limit, payment_term_id, credit_hold, price_list_id,
     (select c.base_currency from app.company c where c.id = company_id) as base_currency`;

/**
 * Every account a party names must be a live, postable account of THIS company. §4.5.7's keys are
 * `(tenant_id, receivable_account_id) → app.account(tenant_id, id)` — tenant-composite only — so the schema
 * admits an account of a SIBLING company, and a party so created would book this company's receivables into
 * that company's ledger account on every later posting. A group or archived account is refused for the same
 * reason `documents.ts` refuses one on a line: nothing downstream would. 404 for an account the caller may
 * not see (it is not confirmed to exist), 400 for one that exists here but takes no postings.
 */
async function assertAccountsBelong(
  tx: Parameters<Parameters<AppEnv["Variables"]["withTenant"]>[0]>[0],
  companyId: string,
  named: readonly { field: string; id: string | null | undefined }[],
): Promise<void> {
  const wanted = named.filter((n): n is { field: string; id: string } => typeof n.id === "string");
  if (wanted.length === 0) return;
  const ids = [...new Set(wanted.map((n) => n.id))];
  const accounts = await tx<{ id: string; is_group: boolean; archived: boolean }[]>`
    select id, is_group, (archived_at is not null) as archived
      from app.account
     where company_id = ${companyId} and id = any(${ids}::uuid[])`;
  const byId = new Map(accounts.map((a) => [a.id, a]));
  for (const { field, id } of wanted) {
    const account = byId.get(id);
    if (!account) {
      throw new AppError("ERR_NOT_FOUND", `${field}: no account ${id} in company ${companyId}`);
    }
    if (account.is_group) {
      throw new AppError(
        "ERR_VALIDATION_FAILED",
        `${field}: account ${id} is a group and takes no postings`,
        {
          errors: [{ path: field, message: "a group account cannot settle a party" }],
        },
      );
    }
    if (account.archived) {
      throw new AppError("ERR_VALIDATION_FAILED", `${field}: account ${id} is archived`, {
        errors: [{ path: field, message: "an archived account cannot settle a party" }],
      });
    }
  }
}

/** contracts §4.2.7 — the company-resolution guard every company-scoped module carries. */
async function companyExists(
  tx: Parameters<Parameters<AppEnv["Variables"]["withTenant"]>[0]>[0],
  companyId: string,
): Promise<void> {
  const [row] = await tx<{ id: string }[]>`select id from app.company where id = ${companyId}`;
  if (!row) throw new AppError("ERR_NOT_FOUND", `no company ${companyId} in this tenant`);
}

/**
 * 4A. `accounting.party.manage` is the module gate and is NOT enough for this one field: spec:2158 gives
 * the back-office clerk credit *terms* and denies them credit-limit *overrides*, and a clerk who can raise
 * a limit has overridden it with no `document_event` to show for it. A field-level pre-flight rather than
 * a second `requirePermission` on the route, because the route legitimately serves callers who touch every
 * other party field. The DATA layer remains the control for the limit's *effect* (0045's trigger); this is
 * the control for who may set it. Clearing a limit (null) is the widest limit there is, so it is asked too.
 *
 * Besides the override route's own gate (`documents.ts`, which asks it of the principal recording an
 * override), this is the one route that evaluates `accounting.credit_limit.override` — no policy names it,
 * which is why 4A Task 2 leaves it out of `POLICY_RESOLVED_CODES`.
 */
async function assertMayWriteCreditLimit(tx: Tx, companyId: string): Promise<void> {
  const [row] = await tx<{ ok: boolean }[]>`
    select app.actor_has(${PERMISSION["accounting.credit_limit.override"]}, ${companyId}) as ok`;
  if (row?.ok !== true) {
    throw new AppError(
      "ERR_RBAC_FORBIDDEN",
      "creditLimit may only be set by a principal holding accounting.credit_limit.override",
    );
  }
}

/**
 * 4A. The commercial terms a body names must belong to THIS company. §4.5.7's keys are tenant-composite
 * only, so the schema admits a sibling company's term or price list, and the route must not (AGENTS.md: an
 * entity id alone must never reach another company's rows). 404 for a row the caller cannot see here, 400
 * for one that exists but is archived. `creditLimit` is in the company's BASE currency (the only currency
 * app.party_open_balance compares in); a limit in any other currency is a 400, never a silent relabel.
 */
async function assertCreditTermsBelong(
  tx: Tx,
  companyId: string,
  b: {
    creditLimit?: { amount: string; currency: string } | null | undefined;
    paymentTermId?: string | null | undefined;
    priceListId?: string | null | undefined;
  },
): Promise<void> {
  if (b.creditLimit !== undefined) await assertMayWriteCreditLimit(tx, companyId);
  if (b.creditLimit) {
    const [company] = await tx<{ base_currency: string }[]>`
      select base_currency from app.company where id = ${companyId}`;
    if (company && company.base_currency.trim() !== b.creditLimit.currency) {
      throw new AppError(
        "ERR_VALIDATION_FAILED",
        `creditLimit must be in the company's base currency ${company.base_currency.trim()}`,
        { errors: [{ path: "creditLimit.currency", message: "not the company's base currency" }] },
      );
    }
  }
  if (typeof b.paymentTermId === "string") {
    const [term] = await tx<{ archived: boolean }[]>`
      select (archived_at is not null) as archived from app.payment_term
       where id = ${b.paymentTermId} and company_id = ${companyId}`;
    if (!term) {
      throw new AppError(
        "ERR_NOT_FOUND",
        `paymentTermId: no payment term ${b.paymentTermId} in company ${companyId}`,
      );
    }
    if (term.archived) {
      throw new AppError("ERR_VALIDATION_FAILED", `paymentTermId: ${b.paymentTermId} is archived`, {
        errors: [{ path: "paymentTermId", message: "an archived term cannot be given to a party" }],
      });
    }
  }
  if (typeof b.priceListId === "string") {
    const [list] = await tx<{ archived: boolean }[]>`
      select (archived_at is not null) as archived from app.price_list
       where id = ${b.priceListId} and company_id = ${companyId}`;
    if (!list) {
      throw new AppError(
        "ERR_NOT_FOUND",
        `priceListId: no price list ${b.priceListId} in company ${companyId}`,
      );
    }
    if (list.archived) {
      throw new AppError("ERR_VALIDATION_FAILED", `priceListId: ${b.priceListId} is archived`, {
        errors: [
          { path: "priceListId", message: "an archived price list cannot be given to a party" },
        ],
      });
    }
  }
}

partyRoutes.openapi(
  createRoute({
    method: "post",
    path: "/",
    tags: ["accounting"],
    middleware: [gate()] as const,
    summary: "Create a party (customer, vendor, employee, student or dealer)",
    request: {
      params: z.object({ companyId: UuidSchema }),
      headers: IdempotencyHeader,
      body: { content: { "application/json": { schema: CreatePartyBody } } },
    },
    responses: {
      201: { description: "Created", content: { "application/json": { schema: PartySchema } } },
      409: {
        description: "Duplicate code or unknown account",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
    },
  }),
  async (c) => {
    const { companyId } = c.req.valid("param");
    const b = c.req.valid("json");
    const rows = await c.var.withTenant(async (tx) => {
      await companyExists(tx, companyId);
      await assertAccountsBelong(tx, companyId, [
        { field: "receivableAccountId", id: b.receivableAccountId },
        { field: "payableAccountId", id: b.payableAccountId },
      ]);
      await assertCreditTermsBelong(tx, companyId, b);
      return tx<PartyRow[]>`
        insert into app.party (tenant_id, company_id, kind, code, name_en, name_ar, receivable_account_id,
                               payable_account_id, currency, tax_registration, email, phone, address,
                               credit_limit, payment_term_id, credit_hold, price_list_id)
        values (${c.var.ctx.tenantId}, ${companyId}, ${b.kind}, ${b.code}, ${b.nameEn}, ${b.nameAr ?? null},
                ${b.receivableAccountId ?? null}, ${b.payableAccountId ?? null}, ${b.currency ?? null},
                ${b.taxRegistration ?? null}, ${b.email ?? null}, ${b.phone ?? null},
                ${JSON.stringify(b.address ?? {})}::text::jsonb,
                ${b.creditLimit?.amount ?? null}::numeric, ${b.paymentTermId ?? null}::uuid,
                ${b.creditHold ?? false}, ${b.priceListId ?? null}::uuid)
        returning ${COLUMNS(tx)}`;
    });
    return c.json(toDto(rows[0]!), 201);
  },
);

partyRoutes.openapi(
  createRoute({
    method: "get",
    path: "/",
    tags: ["accounting"],
    middleware: [gate()] as const,
    summary: "List parties, filtered by kind or code, keyset-paged on (code, id)",
    request: { params: z.object({ companyId: UuidSchema }), query: PartyQuery },
    responses: {
      200: { description: "OK", content: { "application/json": { schema: PartyList } } },
    },
  }),
  async (c) => {
    const { companyId } = c.req.valid("param");
    const q = c.req.valid("query");
    // Keyset pagination on (code, id) — the declared sort key, never a field name reaching SQL as text
    // (contracts §4.2.8, test 27). The cursor codec is the shared one; a second base64url round-trip here
    // would be two spellings of one thing (hazard 9).
    const after = q.cursor ? decodeCursor(q.cursor) : null;
    const afterCode = after ? String(after.k[0]) : null;
    const afterId = after?.id ?? null;
    const kindFilter = q["filter[kind][eq]"] ?? null;
    const codeFilter = q["filter[code][eq]"] ?? null;
    const rows = await c.var.withTenant(async (tx) => {
      await companyExists(tx, companyId);
      return tx<PartyRow[]>`
        select ${COLUMNS(tx)}
          from app.party
         where company_id = ${companyId}
           and (${q.includeArchived === "true"} or archived_at is null)
           and (${kindFilter}::text is null or kind = ${kindFilter})
           and (${codeFilter}::text is null or code = ${codeFilter})
           and (${afterCode}::text is null or (code, id) > (${afterCode}, ${afterId}::uuid))
         order by code, id
         limit ${q.limit}`;
    });
    const last = rows.at(-1);
    return c.json(
      {
        items: rows.map(toDto),
        next_cursor:
          rows.length === q.limit && last ? encodeCursor({ k: [last.code], id: last.id }) : null,
      },
      200,
    );
  },
);

partyRoutes.openapi(
  createRoute({
    method: "get",
    path: "/{partyId}",
    tags: ["accounting"],
    middleware: [gate()] as const,
    summary: "Read one party",
    request: { params: z.object({ companyId: UuidSchema, partyId: UuidSchema }) },
    responses: {
      200: { description: "OK", content: { "application/json": { schema: PartySchema } } },
      404: {
        description: "Unknown",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
    },
  }),
  async (c) => {
    const { companyId, partyId } = c.req.valid("param");
    const rows = await c.var.withTenant(
      (tx) => tx<PartyRow[]>`
        select ${COLUMNS(tx)} from app.party where id = ${partyId} and company_id = ${companyId}`,
    );
    if (rows.length === 0) throw new AppError("ERR_NOT_FOUND", `no party ${partyId}`);
    return c.json(toDto(rows[0]!), 200);
  },
);

partyRoutes.openapi(
  createRoute({
    method: "patch",
    path: "/{partyId}",
    tags: ["accounting"],
    middleware: [gate()] as const,
    summary: "Edit a party's fields — never its code or kind",
    request: {
      params: z.object({ companyId: UuidSchema, partyId: UuidSchema }),
      headers: IdempotencyHeader,
      body: { content: { "application/json": { schema: UpdatePartyBody } } },
    },
    responses: {
      200: { description: "Updated", content: { "application/json": { schema: PartySchema } } },
      404: {
        description: "Unknown",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
      409: {
        description:
          "A changed receivableAccountId or payableAccountId on a party with posted documents (ERR_CONFLICT_REFERENCE) — its ledger rows, ageing and allocations are read on that account",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
    },
  }),
  async (c) => {
    const { companyId, partyId } = c.req.valid("param");
    const b = c.req.valid("json");
    const rows = await c.var.withTenant(async (tx) => {
      await assertAccountsBelong(tx, companyId, [
        { field: "receivableAccountId", id: b.receivableAccountId },
        { field: "payableAccountId", id: b.payableAccountId },
      ]);
      await assertCreditTermsBelong(tx, companyId, b);
      // The 4A fields distinguish "absent" (keep) from null (clear): null is "no limit", "no term", "no list
      // of its own", which `coalesce` could never express.
      return tx<PartyRow[]>`
        update app.party
           set name_en = coalesce(${b.nameEn ?? null}, name_en),
               name_ar = coalesce(${b.nameAr ?? null}, name_ar),
               receivable_account_id = coalesce(${b.receivableAccountId ?? null}, receivable_account_id),
               payable_account_id = coalesce(${b.payableAccountId ?? null}, payable_account_id),
               currency = coalesce(${b.currency ?? null}, currency),
               tax_registration = coalesce(${b.taxRegistration ?? null}, tax_registration),
               email = coalesce(${b.email ?? null}, email),
               phone = coalesce(${b.phone ?? null}, phone),
               address = coalesce(${b.address ? JSON.stringify(b.address) : null}::text::jsonb, address),
               credit_limit = case when ${b.creditLimit !== undefined}
                                   then ${b.creditLimit?.amount ?? null}::numeric else credit_limit end,
               payment_term_id = case when ${b.paymentTermId !== undefined}
                                      then ${b.paymentTermId ?? null}::uuid else payment_term_id end,
               credit_hold = coalesce(${b.creditHold ?? null}::boolean, credit_hold),
               price_list_id = case when ${b.priceListId !== undefined}
                                    then ${b.priceListId ?? null}::uuid else price_list_id end
         where id = ${partyId} and company_id = ${companyId} and archived_at is null
         returning ${COLUMNS(tx)}`;
    });
    if (rows.length === 0) throw new AppError("ERR_NOT_FOUND", `no unarchived party ${partyId}`);
    return c.json(toDto(rows[0]!), 200);
  },
);

/** Archive, never delete (spec:2049). There is deliberately no DELETE route and no DELETE grant:
 *  contracts §3.5.4 pins the grant list and 2B is the only slice that extends it. */
partyRoutes.openapi(
  createRoute({
    method: "post",
    path: "/{partyId}/archive",
    tags: ["accounting"],
    middleware: [gate()] as const,
    summary: "Archive a party",
    request: {
      params: z.object({ companyId: UuidSchema, partyId: UuidSchema }),
      headers: IdempotencyHeader,
      body: { content: { "application/json": { schema: z.object({}).strict() } } },
    },
    responses: {
      200: { description: "Archived", content: { "application/json": { schema: PartySchema } } },
      404: {
        description: "Unknown",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
    },
  }),
  async (c) => {
    const { companyId, partyId } = c.req.valid("param");
    const rows = await c.var.withTenant(
      (tx) => tx<PartyRow[]>`
        update app.party set archived_at = now()
         where id = ${partyId} and company_id = ${companyId} and archived_at is null
         returning ${COLUMNS(tx)}`,
    );
    if (rows.length === 0) throw new AppError("ERR_NOT_FOUND", `no unarchived party ${partyId}`);
    return c.json(toDto(rows[0]!), 200);
  },
);

/**
 * 4A T9 — the party's open balance per currency and in base (contracts §4.8.1), one more sub-path of this
 * module under its own `gate()`: no new `PROBES` key and no change to the module's `permissions`. It reads the
 * LEDGER on the party's control account and is PARTY-FACING — positive is "owed to us" for a customer and
 * "owed by us" for a vendor, which for a vendor is the ledger figure negated. `asOf` is required. The path
 * company is passed into the service, which binds the party to it (AGENTS.md).
 */
partyRoutes.openapi(
  createRoute({
    method: "get",
    path: "/{partyId}/balance",
    tags: ["accounting"],
    middleware: [gate()] as const,
    summary: "A party's open balance per currency and in base, as of a date",
    request: {
      params: z.object({ companyId: UuidSchema, partyId: UuidSchema }),
      query: PartyBalanceQuery,
    },
    responses: {
      200: {
        description: "Open balance per currency and in base (party-facing sign)",
        content: { "application/json": { schema: PartyBalanceSchema } },
      },
      400: {
        description: "asOf missing or not a date",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
      403: {
        description: "Forbidden",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
      404: {
        description: "Not a party of this company",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
    },
  }),
  async (c) => {
    const { companyId, partyId } = c.req.valid("param");
    const { asOf } = c.req.valid("query");
    const bal = await c.var.withTenant((tx) => partyBalance(tx, { companyId, partyId, asOf }));
    return c.json(
      {
        partyId,
        asOf,
        byCurrency: Object.fromEntries(
          Object.entries(bal.byCurrency).map(([code, money]) => [code, money.toJSON()]),
        ),
        base: bal.base.toJSON(),
      },
      200,
    );
  },
);
