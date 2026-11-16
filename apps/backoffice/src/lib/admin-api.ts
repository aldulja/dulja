import type { ZodType } from "zod";
import { ApiError, internalProblem, isAalRefusal, toApiError } from "./problem";

export interface AdminApiOptions {
  baseUrl: string;
  /** Read at call time, never captured: a refreshed token must reach the next request without a remount (UI-01). */
  accessToken: () => string | null;
  /**
   * UI-08: asked once when `/v1` answers 401 for anything but the assurance level. It answers the new access
   * token, or `null` when the session cannot be refreshed — the 401 then stands and the session owner decides.
   */
  refreshAccessToken?: () => Promise<string | null>;
  /** Test seam. */
  fetchImpl?: typeof fetch;
}

export interface RequestOptions {
  /** Cancellation. TanStack Query supplies one per query; a locale switch or an unmount aborts. */
  signal?: AbortSignal;
}

export interface SendOptions extends RequestOptions {
  /**
   * §4.2.9/spec:2055. Omit it and each attempt mints a fresh key, which is right for a fresh submit
   * and wrong for a retry: 0B replays the stored response only for the *same* key with the same
   * body, so a caller retrying a double-clicked "Invite user" must pass the key it used the first
   * time or the invitation is created twice.
   */
  idempotencyKey?: string;
}

export interface AdminApi {
  get<T>(path: string, schema: ZodType<T>, options?: RequestOptions): Promise<T>;
  send<T>(
    method: "POST" | "PUT" | "PATCH" | "DELETE",
    path: string,
    body: unknown,
    schema: ZodType<T>,
    options?: SendOptions,
  ): Promise<T>;
  /**
   * The bytes of a binary resource — a rendered report or an export archive (7A T15, 7C T13). Same door, same
   * bearer token and the same problem envelope on a refusal; only a 2xx body is read as a `Blob` instead of
   * being parsed as JSON.
   */
  download(path: string, options?: RequestOptions): Promise<Blob>;
}

/** A deliberate cancellation is not a failure anyone should be shown; it must reach TanStack Query
 *  as an abort rather than as an error state, so it is the one throw this module passes through. */
const isAbort = (cause: unknown): boolean => cause instanceof Error && cause.name === "AbortError";

/** Machine-shaped, never prose: an error class name, or the constructor name of whatever was thrown. */
const diagnosticFor = (cause: unknown): string =>
  cause instanceof Error ? cause.name : typeof cause;

/** A `ZodError`'s issues, lifted into the envelope's own structured slot. Diagnostic only. */
function issuesFor(cause: unknown): { path: string; message: string }[] | undefined {
  if (!(cause instanceof Error) || !("issues" in cause) || !Array.isArray(cause.issues))
    return undefined;
  return (cause.issues as { path?: unknown[]; message?: unknown }[]).map((issue) => ({
    path: (issue.path ?? []).join("."),
    message: String(issue.message ?? ""),
  }));
}

// 204 has no body; `.json()` on one throws a SyntaxError. The caller's schema still decides whether an
// empty response was acceptable — it is handed `undefined` rather than bypassed.
const json =
  <T>(schema: ZodType<T>) =>
  async (response: Response): Promise<T> =>
    schema.parse(response.status === 204 ? undefined : await response.json());

/**
 * The one door to `/v1`. The response schema is a parameter, not an import, so this file never names a
 * resource schema and the §4.2.8 naming convention can be satisfied by 0B in whatever spelling it chose.
 *
 * Nothing escapes this function except an `ApiError` or an abort. A dead network throws a raw
 * `TypeError`, and a 2xx body that does not match its schema throws a `ZodError`; both would
 * otherwise reach a screen that has only ever been taught to render a problem envelope.
 */
export function createAdminApi({
  baseUrl,
  accessToken,
  refreshAccessToken,
  fetchImpl = fetch,
}: AdminApiOptions): AdminApi {
  const call = async <T>(
    method: string,
    path: string,
    body: unknown,
    read: (response: Response) => Promise<T>,
    options: SendOptions,
    accept = "application/json",
  ): Promise<T> => {
    try {
      // One key for the request and its retry after a refresh: the retry is the same attempt (§4.2.9).
      const idempotencyKey =
        method === "GET" ? undefined : (options.idempotencyKey ?? crypto.randomUUID());
      const send = (token: string | null) => {
        const headers: Record<string, string> = { accept };
        if (token !== null) headers["authorization"] = `Bearer ${token}`;
        if (body !== undefined) headers["content-type"] = "application/json";
        // §4.2.9: the header is required on every unsafe method.
        if (idempotencyKey !== undefined) headers["idempotency-key"] = idempotencyKey;
        return fetchImpl(`${baseUrl}${path}`, {
          method,
          headers,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
      };

      let response = await send(accessToken());
      if (response.status === 401 && refreshAccessToken !== undefined) {
        /*
         * UI-08: an access token that expired while the machine slept is not a dead session. Refresh it
         * once and repeat the request; only a refresh that fails lets the 401 reach the screen, whose
         * refusal flow then hands it to the session owner. An assurance refusal is about the factor, not
         * the token, so refreshing cannot change it.
         */
        const refusal = await toApiError(response, path);
        if (isAalRefusal(refusal)) throw refusal;
        const fresh = await refreshAccessToken();
        if (fresh === null) throw refusal;
        response = await send(fresh);
      }
      if (!response.ok) throw await toApiError(response, path);
      return await read(response);
    } catch (cause) {
      if (cause instanceof ApiError || isAbort(cause)) throw cause;
      const issues = issuesFor(cause);
      throw new ApiError(
        internalProblem({
          instance: path,
          diagnostic: diagnosticFor(cause),
          status: 0, // no HTTP status: the failure is this side of a reply
          requestId: "", // and so no server request id to quote

          ...(issues === undefined ? {} : { issues }),
        }),
      );
    }
  };

  return {
    get: (path, schema, options) => call("GET", path, undefined, json(schema), options ?? {}),
    send: (method, path, body, schema, options) =>
      call(method, path, body, json(schema), options ?? {}),
    download: (path, options) =>
      call("GET", path, undefined, (response) => response.blob(), options ?? {}, "*/*"),
  };
}
