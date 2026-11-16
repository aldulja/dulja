import { assertStaffBranchPermission, staffBranchGate } from "../staff-permission";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { PERMISSION } from "@dulja/contracts/permissions";
import {
  ShiftList,
  ShiftQuery,
  ShiftSchema,
  TillEventList,
  TillEventSchema,
} from "@dulja/contracts/pos/shift";
import {
  encodeCursor,
  decodeCursor,
  UuidSchema,
  TimestampSchema,
  ProblemSchema,
} from "@dulja/contracts";
import { AppError } from "@dulja/contracts";
const problem = () => ({
  description: "request failed",
  content: { "application/problem+json": { schema: ProblemSchema } },
});
import type { AppEnv } from "../../context";
import type { RouteModule } from "../index";

/** The one code all three reads need, at the gate AND on every row (R7). `staffBranchGate` admits a caller
 *  who holds it in ANY branch and `branch_isolation` shows every branch the caller holds ANY role at, so
 *  neither bounds a row to this code; the `app.actor_has` below does, as the sibling staff reads do. */
const read = PERMISSION["pos.report.read"];

export const shiftRoutes = new OpenAPIHono<AppEnv>({
  defaultHook: (result) => {
    if (!result.success) throw result.error;
  },
});

const listRoute = createRoute({
  method: "get",
  path: "/",
  request: { params: z.object({ companyId: UuidSchema }), query: ShiftQuery },
  responses: {
    200: { content: { "application/json": { schema: ShiftList } }, description: "Shifts" },
    403: problem(),
  },
  middleware: [staffBranchGate(read)],
  tags: ["pos"],
});

const detailRoute = createRoute({
  method: "get",
  path: "/{shiftId}",
  request: { params: z.object({ companyId: UuidSchema, shiftId: UuidSchema }) },
  responses: {
    200: { content: { "application/json": { schema: ShiftSchema } }, description: "One shift" },
    403: problem(),
    404: problem(),
  },
  middleware: [staffBranchGate(read)],
  tags: ["pos"],
});

const eventsRoute = createRoute({
  method: "get",
  path: "/{shiftId}/till-events",
  request: {
    params: z.object({ companyId: UuidSchema, shiftId: UuidSchema }),
    query: ShiftQuery.pick({ cursor: true, limit: true }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: TillEventList } },
      description: "Till events",
    },
    403: problem(),
    404: problem(),
  },
  middleware: [staffBranchGate(read)],
  tags: ["pos"],
});

/** The wire shape of one `app.shift` row, in one place because all three handlers below need it. Every
 *  money member is `{ amount, currency }` per `MoneySchema`; `currency` is the SHIFT's currency and not
 *  the company's base, because a drawer is counted in one currency (§4.6.5, amendment A3). */
const toShiftDto = (r: {
  id: string;
  branch_id: string;
  terminal_id: string;
  terminal_code: string;
  opened_at: string;
  closed_at: string | null;
  opened_principal_id: string;
  closed_principal_id: string | null;
  currency: string;
  opening_float: string;
  counted_cash: string | null;
  expected_cash: string | null;
  over_short: string | null;
  over_short_document_id: string | null;
}) => ({
  shiftId: r.id,
  branchId: r.branch_id,
  terminalId: r.terminal_id,
  terminalCode: r.terminal_code,
  openedAt: new Date(r.opened_at).toISOString(),
  closedAt: r.closed_at === null ? null : new Date(r.closed_at).toISOString(),
  openedPrincipalId: r.opened_principal_id,
  closedPrincipalId: r.closed_principal_id,
  currency: r.currency,
  openingFloat: { amount: r.opening_float, currency: r.currency },
  countedCash: r.counted_cash === null ? null : { amount: r.counted_cash, currency: r.currency },
  expectedCash: r.expected_cash === null ? null : { amount: r.expected_cash, currency: r.currency },
  overShort: r.over_short === null ? null : { amount: r.over_short, currency: r.currency },
  overShortDocumentId: r.over_short_document_id,
});

// **The two `select` lists below are written out twice on purpose.** A shared `const SHIFT_COLUMNS = "…"`
// interpolated into a `tx` template would be sent as a PARAMETER rather than as SQL and postgres.js would
// fail on it; interpolating it any other way is `sql.unsafe`, which has exactly three homes and none is
// here (§3.3, `no-sql-concat`). Two literal lists kept in step by hand is the cost of that rule.
//
// **A keyset cursor carries the row's instant at the MICROSECOND, and binds it as text.** The DTO's ISO
// timestamps are milliseconds (`toISOString`), but `timestamptz` holds microseconds. This is defensive: the
// sync write path binds a till's `at` / `occurredAt` as `$n::timestamptz`, which postgres.js serialises
// through a JS `Date`, so every row a till syncs is stored at a whole millisecond and a millisecond cursor,
// tie-broken by id, is exact for it. A row whose instant SQL wrote (`now()`, as the `seedShift` test helper
// does, or any later writer that is not the sync path) holds microseconds, and a cursor cut to the
// millisecond lands before it, so the next page skips (newest-first) or repeats (oldest-first) every such row
// between the two instants. The key is therefore Postgres' own `to_char(… US)` in UTC, which still passes
// `TimestampSchema`, and the WHERE clause casts it `::text::timestamptz` — a parameter written as
// `$n::timestamptz` would be cut to the millisecond again (the users list's `created_at_text` records the
// same trap).

shiftRoutes.openapi(listRoute, async (c) => {
  const { companyId } = c.req.valid("param");
  const q = c.req.valid("query");

  // **Every filter key is mapped to a PARAMETER here, and no field name ever reaches SQL as text**
  // (test 27, `no-sql-concat`). The `filter[…][op]` literals are §4.2.8 Layer 2's default form, declared
  // in `ShiftQuery`; undeclared query keys are stripped by the shared list convention.
  const branchId = q["filter[branchId][eq]"] ?? null;
  const terminalId = q["filter[terminalId][eq]"] ?? null;
  const openedFrom = q["filter[openedAt][gte]"] ?? null;
  const openedTo = q["filter[openedAt][lte]"] ?? null;
  // A tri-state on the wire ("null" | "not_null" | absent) becomes a nullable boolean here: `true` means
  // "closed_at is not null". A boolean parameter and two `is null` tests keep it one statement.
  const closedState = q["filter[closedAt][eq]"] ?? null;
  const wantClosed = closedState === null ? null : closedState === "not_null";

  let cursorOpenedAt: string | null = null;
  let cursorId: string | null = null;
  if (q.cursor !== undefined) {
    const d = decodeCursor(q.cursor);
    if (
      d.k.length !== 1 ||
      !TimestampSchema.safeParse(d.k[0]).success ||
      !UuidSchema.safeParse(d.id).success ||
      typeof d.k[0] !== "string"
    ) {
      throw new AppError("ERR_VALIDATION_FAILED", "cursor is not a valid keyset cursor for shifts");
    }
    cursorOpenedAt = d.k[0];
    cursorId = d.id;
  }

  const rows = await c.var.withTenant(
    (tx) => tx<(Parameters<typeof toShiftDto>[0] & { opened_at_key: string })[]>`
    select s.id::text, s.branch_id::text, s.terminal_id::text, pt.code as terminal_code,
           s.opened_at::text, s.closed_at::text, s.opened_principal_id::text, s.closed_principal_id::text,
           s.currency, s.opening_float::text, s.counted_cash::text, s.expected_cash::text,
           s.over_short::text, s.over_short_document_id::text,
           to_char(s.opened_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as opened_at_key
      from app.shift s
      join app.pos_terminal pt on pt.id = s.terminal_id
      join app.company co on co.id = s.company_id
     where s.company_id = ${companyId}
       and app.actor_has(${read}, s.company_id, s.branch_id)
       and (${branchId}::uuid is null   or s.branch_id  = ${branchId}::uuid)
       and (${terminalId}::uuid is null or s.terminal_id = ${terminalId}::uuid)
       and (${openedFrom}::date is null or (s.opened_at at time zone co.timezone)::date >= ${openedFrom}::date)
       and (${openedTo}::date is null   or (s.opened_at at time zone co.timezone)::date <= ${openedTo}::date)
       and (${wantClosed}::boolean is null
            or (${wantClosed}::boolean and s.closed_at is not null)
            or (not ${wantClosed}::boolean and s.closed_at is null))
       and (${cursorOpenedAt}::text is null
            or (s.opened_at, s.id) < (${cursorOpenedAt}::text::timestamptz, ${cursorId}::uuid))
     order by s.opened_at desc, s.id desc
     limit ${q.limit + 1}`,
  );

  const page = rows.slice(0, q.limit);
  const last = page.at(-1);
  return c.json(
    {
      items: page.map(toShiftDto),
      next_cursor:
        rows.length > q.limit && last !== undefined
          ? encodeCursor({ k: [last.opened_at_key], id: last.id })
          : null,
    },
    200,
  );
});

shiftRoutes.openapi(detailRoute, async (c) => {
  const { companyId, shiftId } = c.req.valid("param");
  const row = await c.var.withTenant(async (tx) => {
    const [found] = await tx<Parameters<typeof toShiftDto>[0][]>`
    select s.id::text, s.branch_id::text, s.terminal_id::text, pt.code as terminal_code,
           s.opened_at::text, s.closed_at::text, s.opened_principal_id::text, s.closed_principal_id::text,
           s.currency, s.opening_float::text, s.counted_cash::text, s.expected_cash::text,
           s.over_short::text, s.over_short_document_id::text
      from app.shift s
      join app.pos_terminal pt on pt.id = s.terminal_id
      join app.company co on co.id = s.company_id
     where s.company_id = ${companyId} and s.id = ${shiftId}`;
    // **404 for a row Form A hides.** A branch manager at branch B asking for a branch-A shift reads zero
    // rows, because the restrictive `branch_isolation` policy makes the row INVISIBLE rather than
    // forbidden — so "not found" is the honest answer, and it leaks nothing about whether the id exists.
    // The same answer covers another tenant's shift (`PROBES` asserts it).
    if (!found)
      throw new AppError(
        "ERR_NOT_FOUND",
        `shift ${shiftId} is not a shift of company ${companyId}`,
      );
    // **403 for a VISIBLE row outside the grant** (R7), as the employee and cashier details answer: a role
    // at the shift's branch makes it visible, and only pos.report.read at that branch makes it readable.
    await assertStaffBranchPermission(tx, read, companyId, found.branch_id);
    return found;
  });
  return c.json(toShiftDto(row), 200);
});

shiftRoutes.openapi(eventsRoute, async (c) => {
  const { companyId, shiftId } = c.req.valid("param");
  const q = c.req.valid("query");

  // The shift is read first, so an unknown or invisible shift is a 404 rather than an empty list — an
  // empty `items` would tell a reader "this drawer had no events", which is a different claim — and a
  // visible shift outside the caller's pos.report.read is the detail read's 403 (R7).
  await c.var.withTenant(async (tx) => {
    const [shift] = await tx<{ branch_id: string }[]>`
    select branch_id::text from app.shift where company_id = ${companyId} and id = ${shiftId}`;
    if (!shift)
      throw new AppError(
        "ERR_NOT_FOUND",
        `shift ${shiftId} is not a shift of company ${companyId}`,
      );
    await assertStaffBranchPermission(tx, read, companyId, shift.branch_id);
  });

  let cursorOccurredAt: string | null = null;
  let cursorId: string | null = null;
  if (q.cursor !== undefined) {
    const d = decodeCursor(q.cursor);
    if (
      d.k.length !== 1 ||
      !TimestampSchema.safeParse(d.k[0]).success ||
      !UuidSchema.safeParse(d.id).success ||
      typeof d.k[0] !== "string"
    ) {
      throw new AppError(
        "ERR_VALIDATION_FAILED",
        "cursor is not a valid keyset cursor for till-events",
      );
    }
    cursorOccurredAt = d.k[0];
    cursorId = d.id;
  }

  // Ascending — a drawer's event stream reads forwards, unlike the shift list, which reads newest first.
  const rows = await c.var.withTenant(
    (tx) => tx<
      {
        id: string;
        shift_id: string;
        kind: string;
        ticket_document_id: string | null;
        cashier_principal_id: string;
        supervisor_principal_id: string | null;
        occurred_at: string;
        occurred_at_key: string;
        client_ref: string;
        reason: string | null;
      }[]
    >`
    select id::text, shift_id::text, kind, ticket_document_id::text, cashier_principal_id::text,
           supervisor_principal_id::text, occurred_at::text, client_ref::text, reason,
           to_char(occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as occurred_at_key
      from app.till_event
     where company_id = ${companyId} and shift_id = ${shiftId}
       and app.actor_has(${read}, company_id, branch_id)
       and (${cursorOccurredAt}::text is null
            or (occurred_at, id) > (${cursorOccurredAt}::text::timestamptz, ${cursorId}::uuid))
     order by occurred_at, id
     limit ${q.limit + 1}`,
  );

  const page = rows.slice(0, q.limit);
  const last = page.at(-1);
  return c.json(
    {
      items: page.map((r) => ({
        id: r.id,
        shiftId: r.shift_id,
        kind: TillEventSchema.shape.kind.parse(r.kind),
        ticketDocumentId: r.ticket_document_id,
        cashierPrincipalId: r.cashier_principal_id,
        supervisorPrincipalId: r.supervisor_principal_id,
        occurredAt: new Date(r.occurred_at).toISOString(),
        clientRef: r.client_ref,
        reason: r.reason,
      })),
      next_cursor:
        rows.length > q.limit && last !== undefined
          ? encodeCursor({ k: [last.occurred_at_key], id: last.id })
          : null,
    },
    200,
  );
});

export const shiftRouteModule: RouteModule = {
  path: "/v1/companies/:companyId/shifts",
  router: shiftRoutes,
  permissions: [PERMISSION["pos.report.read"]],
  auth: "human",
};
