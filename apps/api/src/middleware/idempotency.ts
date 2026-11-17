import { createHash, timingSafeEqual } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import type { Sql } from "postgres";
import { AppError } from "@dulja/contracts";
import { withTenant } from "@dulja/db";
import type { AppEnv } from "../context";
import { toProblemResponse } from "../problem";
const unsafe = new Set(["POST", "PUT", "PATCH", "DELETE"]);
export const RECLAIM_AFTER_SECONDS = 120;
/**
 * The transaction-scoped advisory lock that says a key's request is alive (CON-01, ADR 0020 amendment
 * 2026-11-15). The request-spanning transaction takes it before the handler runs and holds it until it
 * commits or rolls back; a reclaim must take it too (`pg_try_advisory_xact_lock`), so a reservation whose
 * request is still running is never reclaimed, however long it runs. The key space is the repository's
 * one-argument `hashtextextended` convention, under a prefix of its own.
 */
const lockKey = (tenantId: string, principalId: string, key: string): string =>
  `idempotency:${tenantId}/${principalId}/${key}`;
/**
 * postgres.js gives a transaction a `savepoint`; the `Sql` type `withTenant` hands back does not declare
 * one, because `runOnce` casts the transaction to `Sql` before calling us. `with-tenant.ts:24` recognises a
 * transaction by exactly this property.
 */
type TransactionScope = Sql & { savepoint<T>(fn: (tx: Sql) => Promise<T>): Promise<T> };
/** `with-tenant.ts:28`'s reader of a driver error's SQLSTATE, which that module does not export. */
const sqlstate = (error: unknown): string =>
  typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : "";
const stable = (value: unknown): string =>
  Array.isArray(value)
    ? `[${value.map(stable).join(",")}]`
    : value && typeof value === "object"
      ? `{${Object.keys(value)
          .toSorted()
          .map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`)
          .join(",")}}`
      : (JSON.stringify(value) ?? "null");
/**
 * Unsafe methods whose handler writes nothing, so a replay may RE-EXECUTE rather than return a stored body
 * (contracts §4.2.9). Printing is the only member: `POST …/print` reads a document and a template and writes
 * no row, so re-running it is exactly as idempotent as returning a cached answer — and a PDF has no place
 * in a `jsonb` column. **A route that writes may never join this list.** `assertRouteGates` reads it too:
 * a read code may gate an unsafe method only on a route listed here (`markWriteFreeGate`).
 *
 * Matched against the CONCRETE path, not a route pattern. This middleware is registered with `app.use` in
 * `createApp`, so `c.req.routePath` here is *this middleware's* registered pattern — not the terminal
 * handler's — and a pattern comparison would never match. The concrete path is `routedPath`'s.
 */
export const REPLAY_BY_RERUN: readonly { method: string; path: RegExp }[] = [
  { method: "POST", path: /^\/v1\/companies\/[^/]+\/documents\/[^/]+\/print$/ },
];

/**
 * The path Hono ROUTED this request on — `c.req.path`, which Hono computes once per request with
 * `decodeURI` — and the one path both lists below, and the request fingerprint, are read against.
 * `new URL(c.req.url).pathname` keeps the request's percent-encoding while the router decodes it, so
 * `…/%70oll`, `…/cance%6C` and `…/einvoice%2Dtransmissions/…` reached the poll and cancel handlers
 * without matching SELF_TRANSACTED, and ran inside the request-spanning transaction whose pool
 * deadlock that list exists to prevent (PR 11 review). A reserved character (`%2F`, `%3F`, `%25`)
 * stays encoded here exactly as the router leaves it, so a matcher sees no separator the router did
 * not. `isReplayByRerunPath` and `isSelfTransactedPath` take a path in this form; `assertRouteGates`
 * passes a route pattern with its parameters replaced, which is already in it.
 */
function routedPath(c: Context<AppEnv>): string {
  return c.req.path;
}

export function isReplayByRerunPath(method: string, path: string): boolean {
  return REPLAY_BY_RERUN.some((r) => r.method === method && r.path.test(path));
}

export function isReplayByRerun(c: Context<AppEnv>): boolean {
  return isReplayByRerunPath(c.req.method, routedPath(c));
}

/**
 * Unsafe routes whose handler writes ONLY through a service's own short transactions on the pool
 * (`c.var.db`), never through `c.var.withTenant`, because that service brackets a call to a third party
 * with them (ADR 0053: claim → call → record, no transaction across the call). Such a route runs OUTSIDE
 * the request-spanning transaction below, like a `REPLAY_BY_RERUN` route; unlike one, its REAL response
 * is recorded afterwards, in one more short transaction, and a replayed key returns that stored answer.
 *
 * Inside the request-spanning transaction it held one pooled connection for the whole request while
 * its service waited for ANOTHER from the same pool: as many concurrent requests as the pool has
 * connections held every one and waited for ever, and each later request queued behind them
 * (ADR 0053, amendment 2026-10-06). The guarantee that transaction buys — the handler's writes and the
 * record of its response commit together — never covered these handlers, whose writes commit in the
 * service's own transactions either way. What a crash between those commits and the response record
 * costs: the key stays `response_code null`, so after RECLAIM_AFTER_SECONDS a retry with it runs the
 * handler again — another poll, or a cancel the claim refuses with 409 because the row is cancelled.
 *
 * **A route that writes through `c.var.withTenant` may never join this list**: its writes would commit
 * apart from the record of its response, which is the double write §4.2.9's single transaction exists
 * to prevent. Matched against the CONCRETE path, for the reason `REPLAY_BY_RERUN` gives, and against
 * the ROUTED one (`routedPath`): every spelling that reaches these handlers must be a member, or one
 * percent-encoded letter puts the request back inside that transaction.
 */
export const SELF_TRANSACTED: readonly { method: string; path: RegExp }[] = [
  {
    method: "POST",
    path: /^\/v1\/companies\/[^/]+\/einvoice-transmissions\/[^/]+\/(?:cancel|poll)$/,
  },
];

export function isSelfTransactedPath(method: string, path: string): boolean {
  return SELF_TRANSACTED.some((r) => r.method === method && r.path.test(path));
}

export function isSelfTransacted(c: Context<AppEnv>): boolean {
  return isSelfTransactedPath(c.req.method, routedPath(c));
}

/**
 * Unsafe routes whose handler reads, then does slow work that needs no database — a Chromium render per
 * employee, an object-store PUT — and writes only at its end (CON-02). For such a route the request
 * transaction opens at the handler's FIRST WRITE, not before the handler: every `c.var.withTenant` call
 * runs in its own short transaction, and the first one that writes (`txid_current_if_assigned()` is set
 * — any row write or row lock assigns one) stays open; every later call joins it as a savepoint, and the
 * record of the response commits in it. So the handler's writes and that record still commit together
 * (ADR 0020 decision 3), and no pooled connection sits idle in a transaction through the renders.
 *
 * What a member gives up: its reads before the first write are separate transactions, so a lock a read
 * takes without writing (an advisory xact lock) ends with its call, and no liveness lock covers the slow
 * part, where only the fence protects the key (ADR 0020 amendment 2026-11-15). **Only a route whose
 * calls are sequential and whose reads hold nothing the write depends on may join.** Matched against the
 * routed path, like the lists above.
 */
export const TRANSACTION_AT_FIRST_WRITE: readonly { method: string; path: RegExp }[] = [
  { method: "POST", path: /^\/v1\/companies\/[^/]+\/payroll-runs\/[^/]+\/payslips$/ },
];

export function isTransactionAtFirstWritePath(method: string, path: string): boolean {
  return TRANSACTION_AT_FIRST_WRITE.some((r) => r.method === method && r.path.test(path));
}

/** Successful credential issuance is acknowledged without persisting or replaying its plaintext secret.
 * The first response and this safe replay record commit atomically (contracts §4.2.9, ADR 0055). */
export const ONE_SHOT_SECRET_RESPONSES: readonly { method: string; path: RegExp }[] = [
  { method: "POST", path: /^\/v1\/admin\/terminals\/enrolments$/ },
];

export function idempotency(db: Sql): MiddlewareHandler<AppEnv> {
  return async (context, next) => {
    if (!unsafe.has(context.req.method)) return next();
    const key = context.req.header("Idempotency-Key");
    if (!key)
      throw new AppError(
        "ERR_IDEMPOTENCY_KEY_MISSING",
        `${context.req.method} requires an Idempotency-Key`,
      );
    if (key.length > 200)
      throw new AppError("ERR_VALIDATION_FAILED", "Idempotency-Key exceeds 200 characters");
    // The fingerprint names the request the server EXECUTES: the routed path, as the two lists read
    // it. Two spellings Hono routes to the same handler with the same parameters are one request, so
    // a retry whose client or proxy re-encoded a segment replays its answer instead of being refused
    // as reuse — and the key stays bound to its tenant, its principal and its body either way. A path
    // with no `%` digests exactly as it did when this read the URL's own spelling.
    const path = routedPath(context);
    // Hono caches BOTH `text()` and `formData()`, so exactly one of these runs and the handler re-uses it.
    // 2C: a multipart body is digested as its PARSED PARTS, never as text — see canonicalForm.
    const contentType = context.req.header("content-type") ?? "";
    let canonical: string;
    if (contentType.includes("multipart/form-data")) {
      let form: FormData;
      try {
        form = await context.req.formData();
      } catch {
        // A truncated or boundary-less multipart body is the CLIENT's mistake: a 400 with a path, never the
        // parser's TypeError reaching app.onError as an ERR_INTERNAL 500 and an "unhandled" log line.
        throw new AppError("ERR_VALIDATION_FAILED", "the multipart body could not be parsed", {
          errors: [{ path: "body", message: "expected a well-formed multipart/form-data body" }],
        });
      }
      canonical = await canonicalForm(form);
    } else {
      const raw = await context.req.text();
      canonical = raw;
      try {
        canonical = stable(JSON.parse(raw));
      } catch {}
    }
    const hash = createHash("sha256")
      .update(`${context.req.method}\n${path}\n${canonical}`)
      .digest();
    const ctx = context.get("ctx");
    // The reservation commits on its own, ahead of the transaction that runs the handler. Folding it into
    // that transaction would hold this key's row lock for the whole request, so a concurrent duplicate
    // would wait out the first request instead of being told ERR_IDEMPOTENCY_IN_FLIGHT in milliseconds.
    const lock = lockKey(ctx.tenantId, ctx.actorId, key);
    const reservation = await withTenant(db, ctx, async (tx) => {
      // The reclaim leaves request_hash alone and demands that it already match. Writing
      // `request_hash = excluded.request_hash` let a slow in-flight R1 (body B1), reclaimed after
      // RECLAIM_AFTER_SECONDS by R2 (body B2), leave the row holding B2's hash; R1 then recorded its own
      // response into that row and a later replay of B2 was served R1's answer. A different body against
      // a reclaimable key is reuse like any other mismatch, and the read below is what says so.
      // Age alone never proves the holder gone (CON-01): a request that outlives the window — a slow
      // render, a wait for a pooled connection — was reclaimed while it ran, the retry ran the handler
      // beside it, and both committed. The reclaim now also needs the key's advisory lock, which a live
      // request holds for its whole transaction; the try-lock is the last conjunct so a fresh key never
      // reaches it, and it is released when this short transaction commits.
      // `created_at` is the reservation's fencing token: a reclaim moves it, and the request records its
      // response only where it still holds its own (below), so a superseded request rolls back. It
      // travels as text and is cast in SQL (`::text::timestamptz`): postgres.js serialises a
      // `timestamptz` parameter through a JS Date, which drops the microseconds.
      const claimed = await tx<
        { token: string }[]
      >`insert into app.idempotency_key(tenant_id,principal_id,key,request_hash) values(${ctx.tenantId},${ctx.actorId},${key},${hash}) on conflict(tenant_id,principal_id,key) do update set created_at=now() where app.idempotency_key.response_code is null and app.idempotency_key.created_at<now()-make_interval(secs=>${RECLAIM_AFTER_SECONDS}) and app.idempotency_key.request_hash=excluded.request_hash and pg_try_advisory_xact_lock(hashtextextended(${lock},0)) returning created_at::text as token`;
      if (claimed.length) return { kind: "fresh" as const, token: claimed[0]!.token };
      const [row] = await tx<
        { request_hash: Buffer; response_code: number | null; response_body: unknown }[]
      >`select request_hash,response_code,response_body from app.idempotency_key where tenant_id=${ctx.tenantId} and principal_id=${ctx.actorId} and key=${key}`;
      // Gone between the two statements (purged): nothing to fence, so in flight — the retry finds it free.
      if (!row) return { kind: "flight" as const };
      if (row.request_hash.length !== hash.length || !timingSafeEqual(row.request_hash, hash))
        return { kind: "reused" as const };
      if (row.response_code === null) return { kind: "flight" as const };
      // A naturally idempotent unsafe method re-runs: its stored row is a descriptor, not a body (2C).
      if (isReplayByRerun(context)) return { kind: "rerun" as const };
      return { kind: "replay" as const, status: row.response_code, body: row.response_body };
    });
    if (reservation.kind === "reused")
      throw new AppError("ERR_IDEMPOTENCY_KEY_REUSED", `key ${key} was reused`);
    if (reservation.kind === "flight")
      throw new AppError("ERR_IDEMPOTENCY_IN_FLIGHT", `key ${key} is in flight`);
    if (reservation.kind === "replay")
      return new Response(JSON.stringify(reservation.body), {
        status: reservation.status,
        headers: {
          "content-type":
            reservation.status >= 400 ? "application/problem+json" : "application/json",
          "Idempotency-Replayed": "true",
          "X-Request-Id": context.get("requestId"),
        },
      });
    // The reservation's fencing token, kept outside the narrowing the closures below cannot see.
    const token = reservation.kind === "fresh" ? reservation.token : null;
    if (isReplayByRerun(context) || isSelfTransacted(context)) {
      // A write-free route (§4.2.9) runs OUTSIDE the request-spanning transaction below. That transaction
      // exists so a handler's writes and the record of its response commit together; a handler that writes
      // nothing gains nothing from it and loses a pooled connection for its whole duration — for the print
      // route, the seconds a browser takes to render — and the descriptor is then computed inside the same
      // open transaction. Here every `c.var.withTenant` the handler makes is its own short transaction, and
      // the descriptor is recorded in one more. A crash between the two costs nothing: a replayed key on this
      // route re-runs the handler anyway.
      // A SELF_TRANSACTED route takes the same path for a different reason (see the list): its service
      // writes in its own short transactions around a remote call, and a connection held here for the
      // request would starve the pool that service draws from. Its recorded body is the real JSON answer,
      // which the `replay` branch above returns for a repeated key.
      let answer: Response;
      try {
        await next();
        answer = context.res;
      } catch (error) {
        answer = toProblemResponse(context, error);
      }
      const recorded = await recordedBody(answer);
      // No connection is held across this handler, so no lock says it is alive: these routes keep the
      // age-only reclaim (ADR 0020 amendment 2026-11-15). The token keeps a superseded request from
      // overwriting the record of the one that took its key over. A re-run of a completed write-free key
      // owns no reservation and refreshes its descriptor, as it always did.
      await withTenant(db, ctx, (tx) =>
        token === null
          ? tx`update app.idempotency_key set response_code=${answer.status},response_body=${tx.json(recorded as never)} where tenant_id=${ctx.tenantId} and principal_id=${ctx.actorId} and key=${key}`
          : tx`update app.idempotency_key set response_code=${answer.status},response_body=${tx.json(recorded as never)} where tenant_id=${ctx.tenantId} and principal_id=${ctx.actorId} and key=${key} and created_at=${token}::text::timestamptz and response_code is null`,
      );
      context.res = answer;
      return;
    }
    if (isTransactionAtFirstWritePath(context.req.method, routedPath(context))) {
      context.res = await atFirstWrite(db, context, next, ctx, key, lock, token!);
      return;
    }
    let dispatched = false;
    // The binding `authenticate` left, put back below. The rebinding is the open transaction's and must
    // not outlive it by even one statement: once withTenant returns, `tx`'s connection is back in the
    // pool and a savepoint taken on it has nowhere to run. Nothing downstream of this middleware calls
    // `c.var.withTenant` after its own `next()` today — `logger` and `otel` only read — so restoring it
    // fixes no live defect; it keeps the next middleware that does from finding out by way of a
    // connection error nobody would trace back to here.
    const perRequest = context.get("withTenant");
    // One transaction for the handler AND the record of its response. They used to be two: the handler's
    // own transaction committed, and only then did a second one write response_code. A crash in between
    // left a committed mutation under a row that still read `response_code null`, so after
    // RECLAIM_AFTER_SECONDS the key was reclaimed and the mutation ran a second time — the double-write
    // this middleware exists to prevent.
    const response = await withTenant(db, ctx, async (tx) => {
      // withTenant retries its callback once on a deadlock or serialization failure. That is right for a
      // callback of pure database work and wrong for this one: hono's compose refuses a second `next()`,
      // and a handler that has already run would mutate twice. Refuse the retry by name rather than let
      // it surface as compose's own error. ERR_INTERNAL is not a retryable SQLSTATE, so this ends there.
      if (dispatched)
        throw new AppError(
          "ERR_INTERNAL",
          `the transaction for ${key} could not be committed, and its handler has already run`,
        );
      dispatched = true;
      // The key's liveness lock, held until this transaction ends (CON-01). Blocking, not a try: the only
      // other holder is a reclaim attempt's short transaction, or — if this request waited past
      // RECLAIM_AFTER_SECONDS for its connection — the request that took the key over, which the fence
      // below then refuses to run beside.
      await lockAndFence(tx, ctx, key, lock, token!);
      const scope = tx as TransactionScope;
      // Every downstream `c.var.withTenant` joins this transaction as a savepoint instead of opening one
      // of its own — `withTenant` refuses a transaction outright (ERR_TENANT_CONTEXT_NESTED), and it is
      // right to: app.tenant_id is already set here. A savepoint per call rather than one around the
      // whole handler keeps each call as atomic as the separate transaction it replaces, and keeps a
      // failed statement from poisoning this transaction — the unique violation a handler raises must
      // still leave it able to write the row below (tests/regression/legacy-083.test.ts).
      context.set("withTenant", joinAsSavepoint(scope));
      const answer = await dispatch(context, next);
      // Fenced as well as locked: under the lock nothing can move the token, and if anything ever did, the
      // handler's writes roll back with this throw rather than commit beside another request's.
      await recordFenced(tx, ctx, key, token!, replayAnswerFor(context, answer));
      return answer;
    }).finally(() => context.set("withTenant", perRequest));
    context.res = response;
  };
}

/**
 * Every downstream `c.var.withTenant` joins the open transaction as a savepoint instead of opening one
 * of its own — `withTenant` refuses a transaction outright (ERR_TENANT_CONTEXT_NESTED), and it is right
 * to: app.tenant_id is already set here. A savepoint per call rather than one around the whole handler
 * keeps each call as atomic as the separate transaction it replaces, and keeps a failed statement from
 * poisoning this transaction — the unique violation a handler raises must still leave it able to write
 * the record (tests/regression/legacy-083.test.ts).
 */
function joinAsSavepoint(scope: TransactionScope) {
  return async <T>(fn: (sp: Sql) => Promise<T>): Promise<T> => {
    try {
      return await scope.savepoint<T>(fn);
    } catch (error) {
      // `with-tenant.ts:57`'s retry-once, kept rather than lost to the rebinding: `rollback to
      // savepoint` leaves this transaction holding nothing the retry can collide on, because
      // everything on it so far is set_config and read-only SELECTs, which take no row locks at READ
      // COMMITTED. (A handler retrying its SECOND call does hold the first's locks, so there the
      // retry is weaker than the fresh transaction it replaces.) Without it a deadlock becomes
      // ERR_INTERNAL — `fromDatabaseError` maps no 40xxx — recorded against the key and replayed as
      // a 500 for the full 24-hour retention.
      if (["40P01", "40001"].includes(sqlstate(error))) return scope.savepoint<T>(fn);
      throw error;
    }
  };
}

async function dispatch(context: Context<AppEnv>, next: () => Promise<void>): Promise<Response> {
  try {
    await next();
    return context.res;
  } catch (error) {
    // hono's compose catches an Error at the level that threw it and answers through app.onError, so
    // `next()` resolves even for a failing handler and context.res already holds the problem. What is
    // left for this branch is a thrown non-Error, which compose re-throws.
    return toProblemResponse(context, error);
  }
}

/** The answer a replay of this key returns: the answer itself, except a one-shot secret's (ADR 0055). */
function replayAnswerFor(context: Context<AppEnv>, answer: Response): Response {
  const secretIssuance =
    answer.status === 201 &&
    ONE_SHOT_SECRET_RESPONSES.some(
      (route) => route.method === context.req.method && route.path.test(routedPath(context)),
    );
  return secretIssuance
    ? toProblemResponse(
        context,
        new AppError(
          "ERR_IDEMPOTENCY_KEY_REUSED",
          "This enrolment code was issued once. Use a fresh key and terminal code to issue a new enrolment.",
        ),
      )
    : answer;
}

/** Records the response where the reservation still carries this request's token; refuses otherwise. */
async function recordFenced(
  tx: Sql,
  ctx: { tenantId: string; actorId: string },
  key: string,
  token: string,
  answer: Response,
): Promise<void> {
  const body = await recordedBody(answer);
  const rows =
    await tx`update app.idempotency_key set response_code=${answer.status},response_body=${tx.json(body as never)} where tenant_id=${ctx.tenantId} and principal_id=${ctx.actorId} and key=${key} and created_at=${token}::text::timestamptz and response_code is null returning 1`;
  if (!rows.length) throw superseded(key);
}

/** The key's liveness lock, then the fence: this request still owns its reservation, or it stops here. */
async function lockAndFence(
  tx: Sql,
  ctx: { tenantId: string; actorId: string },
  key: string,
  lock: string,
  token: string,
): Promise<void> {
  await tx`select pg_advisory_xact_lock(hashtextextended(${lock},0))`;
  const [own] =
    await tx`select 1 from app.idempotency_key where tenant_id=${ctx.tenantId} and principal_id=${ctx.actorId} and key=${key} and created_at=${token}::text::timestamptz and response_code is null`;
  if (!own) throw superseded(key);
}

/**
 * A `TRANSACTION_AT_FIRST_WRITE` route (CON-02). Each `c.var.withTenant` call opens its own transaction
 * under the key's lock and fence; a call that wrote nothing commits at once and gives its connection back.
 * The first call that wrote keeps its transaction open — the request transaction from then on — later
 * calls join it as savepoints, and once the handler answers, the response is recorded in it and it
 * commits. A handler that never writes has its answer recorded in one short transaction of its own.
 */
async function atFirstWrite(
  db: Sql,
  context: Context<AppEnv>,
  next: () => Promise<void>,
  ctx: Parameters<typeof withTenant>[1],
  key: string,
  lock: string,
  token: string,
): Promise<Response> {
  const perRequest = context.get("withTenant");
  let finish: ((answer: Response) => void) | null = null;
  let committed: Promise<unknown> | null = null;
  let scope: TransactionScope | null = null;
  context.set("withTenant", async <T>(fn: (tx: Sql) => Promise<T>): Promise<T> => {
    if (scope) return joinAsSavepoint(scope)(fn);
    return new Promise<T>((resolveCall, rejectCall) => {
      let handedOver = false;
      const run = withTenant(db, ctx, async (tx) => {
        // withTenant's deadlock retry may re-run a call that has not handed its transaction over; once
        // the handler has carried on with this transaction's result, a retry would re-run nothing it saw.
        if (handedOver)
          throw new AppError(
            "ERR_INTERNAL",
            `the transaction for ${key} could not be committed, and its handler has already run`,
          );
        await lockAndFence(tx, ctx, key, lock, token);
        const value = await fn(tx);
        const [{ wrote }] = (await tx`select txid_current_if_assigned() is not null as wrote`) as [
          { wrote: boolean },
        ];
        if (!wrote) {
          resolveCall(value);
          return;
        }
        handedOver = true;
        scope = tx as TransactionScope;
        const answered = new Promise<Response>((resolve) => {
          finish = resolve;
        });
        resolveCall(value);
        const answer = await answered;
        await recordFenced(tx, ctx, key, token, answer);
      });
      committed = run;
      run.catch((error: unknown) => {
        if (!handedOver) rejectCall(error);
      });
    });
  });
  try {
    const answer = await dispatch(context, next);
    if (finish && committed) {
      (finish as (answer: Response) => void)(answer);
      try {
        await committed;
      } catch (error) {
        // The handler's writes rolled back with the record: what it answered did not happen.
        return toProblemResponse(context, error);
      }
      return answer;
    }
    await withTenant(db, ctx, (tx) => recordFenced(tx, ctx, key, token, answer));
    return answer;
  } finally {
    context.set("withTenant", perRequest);
  }
}

/** A request whose reservation another request took over: it answers in-flight and writes nothing. */
const superseded = (key: string): AppError =>
  new AppError("ERR_IDEMPOTENCY_IN_FLIGHT", `key ${key} is in flight`);

/**
 * What `app.idempotency_key.response_body` holds for a response: the JSON body itself, or — for a binary
 * response — what an auditor needs and nothing more: what it was, how big, and its digest. The bytes never
 * enter the database (2C).
 */
async function recordedBody(answer: Response): Promise<unknown> {
  const answerType = answer.headers.get("content-type") ?? "";
  if (answerType === "" || answerType.includes("json")) {
    try {
      return JSON.parse(await answer.clone().text()) as unknown;
    } catch {
      return null;
    }
  }
  const bytes = Buffer.from(await answer.clone().arrayBuffer());
  return {
    contentType: answerType.split(";")[0]!.trim(),
    byteSize: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

/**
 * The canonical form of a multipart body: every part reduced to `[name, fileName, contentType, sha256(value)]`
 * and the parts sorted, so two requests carrying the same parts hash identically whatever order they were
 * appended in. The multipart BOUNDARY is deliberately absent: `new Request(…, { body: formData })` generates a
 * fresh random boundary for every construction, so a boundary in the digest would make every honest retry of an
 * upload look like a different body and return ERR_IDEMPOTENCY_KEY_REUSED (§4.2.9). A file part hashes its
 * BYTES, never their UTF-8 re-encoding, which is what `c.req.text()` got wrong for anything above 0x7f.
 */
async function canonicalForm(form: FormData): Promise<string> {
  const parts: [string, string, string, string][] = [];
  // Bun and Node expose different ambient FormData entry types; uploaded entries are File objects.
  const entries = form.entries() as IterableIterator<[string, string | import("node:buffer").File]>;
  for (const [name, value] of entries) {
    parts.push(
      typeof value === "string"
        ? [name, "", "", createHash("sha256").update(value, "utf8").digest("hex")]
        : [
            name,
            value.name,
            value.type,
            createHash("sha256")
              .update(Buffer.from(await value.arrayBuffer()))
              .digest("hex"),
          ],
    );
  }
  parts.sort((x, y) => (x[0] === y[0] ? x[3].localeCompare(y[3]) : x[0].localeCompare(y[0])));
  return JSON.stringify(parts);
}
