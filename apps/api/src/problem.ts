import type { Context } from "hono";
import { ZodError } from "zod";
import {
  AppError,
  ERRORS,
  fromDatabaseError,
  fromDomainError,
  type ErrCode,
  type Problem,
} from "@dulja/contracts";
import { PostingError, ReportError, SyncError, TenantContextError } from "@dulja/db";
import { ReportDefinitionError } from "@dulja/domain";
import { PayrollCalculationError } from "@dulja/domain/payroll";
import type { AppEnv } from "./context";

function hasErrorCode(error: unknown): error is { code: string; message?: string } {
  return (
    typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
  );
}

export function toProblem(context: Context<AppEnv>, error: unknown): Problem {
  const appError =
    error instanceof AppError
      ? error
      : error instanceof ZodError
        ? new AppError("ERR_VALIDATION_FAILED", "one or more fields are invalid", {
            errors: error.issues.map((issue) => ({
              path: issue.path.join("."),
              message: issue.message,
            })),
          })
        : error instanceof TenantContextError
          ? new AppError(error.code as ErrCode, error.message)
          : // PostingErrorCode is a literal subset of ErrCode, so this branch needs no cast — and
            // deliberately does not take one: the cast is what would let a missing ERRORS row through
            // silently. packages/db may not import @dulja/contracts (spec:2389), which is why the
            // posting service throws its own class and this is the one place it becomes an AppError.
            error instanceof PostingError || error instanceof SyncError
            ? new AppError(error.code, error.detail)
            : // packages/db and packages/domain cannot import AppError (§3.1), so the report engine's two
              // error classes carry the code and are translated here (7A T5, §4.2.4). ReportErrorCode is a
              // literal subset of ErrCode, like PostingErrorCode; ReportDefinitionError's JSON-Pointer
              // `errors` reach the wire because §4.2.4 lets ERR_VALIDATION_FAILED carry them. 8B's payroll
              // calculator (packages/domain/payroll) raises PayrollCalculationError the same way (A9).
              error instanceof ReportError || error instanceof PayrollCalculationError
              ? new AppError(error.code, error.detail)
              : error instanceof ReportDefinitionError
                ? new AppError(error.code, error.message, { errors: [...error.errors] })
                : hasErrorCode(error)
                  ? (fromDomainError(error) ?? fromDatabaseError(error))
                  : new AppError("ERR_INTERNAL", "the request could not be completed");
  const def = ERRORS[appError.code];
  const problem: Problem = {
    type: `urn:dulja:error:${appError.code}`,
    title: def.title,
    // The batch wrapper describes a refused item inside HTTP 200. A thrown error
    // still needs a failure status when surfaced as a standalone Problem.
    status:
      appError.code === "ERR_SYNC_TICKET_REJECTED" ||
      appError.code === "ERR_SYNC_MESSAGE_UNSUPPORTED"
        ? 422
        : def.status,
    detail: appError.detail,
    instance: new URL(context.req.url).pathname,
    code: appError.code,
    remedy: def.remedy,
    requestId: context.get("requestId") ?? "",
  };
  return appError.extra?.errors ? { ...problem, errors: appError.extra.errors } : problem;
}
export function toProblemResponse(context: Context<AppEnv>, error: unknown): Response {
  const problem = toProblem(context, error);
  const headers: Record<string, string> = {
    "content-type": "application/problem+json",
    "X-Request-Id": problem.requestId,
  };
  if (problem.code === "ERR_IDEMPOTENCY_IN_FLIGHT") headers["Retry-After"] = "2";
  return new Response(JSON.stringify(problem), {
    status: problem.status,
    headers,
  });
}
