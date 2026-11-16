import { FAILURE_DETAIL_MAX } from "@dulja/db";

/**
 * The ONE failure shape both asynchronous status resources show — a report run (`reporting.render`) and a
 * tenant export (`admin.export.run`): `CODE: detail`. Every error those paths raise on purpose carries a stable
 * `ERR_*` code (`ReportError`, `ReportDefinitionError`, `AppError`); anything else is `ERR_INTERNAL`.
 *
 * Capped at `FAILURE_DETAIL_MAX` characters, keeping the code: the reason is shown to a waiting user and stored
 * on the row, and an unbounded driver or engine message (a stack, a whole SQL statement) belongs in the log
 * line the handler writes beside it, not in either. The stores cap again at the same figure, so a caller that
 * bypasses this helper cannot store more (Phase 7 review, finding 6). The figure is `@dulja/db`'s — the stores'
 * own constant, re-exported here — so the helper and the stores cannot drift (second review, finding 7).
 */
export { FAILURE_DETAIL_MAX };

export function failureDetail(error: unknown): string {
  let detail: string;
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    detail = `${typeof code === "string" && code.startsWith("ERR_") ? code : "ERR_INTERNAL"}: ${error.message}`;
  } else {
    detail = `ERR_INTERNAL: ${String(error)}`;
  }
  return detail.slice(0, FAILURE_DETAIL_MAX);
}
