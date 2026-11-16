import type { PendingQuery, Row } from "postgres";

/**
 * What a postgres.js tagged template evaluates to before it is awaited. Every dataset composes fragments into
 * one larger tagged template; nothing is ever concatenated as text (§3.3, test 27).
 *
 * If the installed postgres.js type declarations export these two names differently, alias them HERE — a
 * `string` return type would silently re-open SAH-036/037/069 and is not an acceptable fallback.
 */
export type SqlFragment = PendingQuery<Row[]>;
