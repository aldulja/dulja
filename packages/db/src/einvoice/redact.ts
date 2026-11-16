// packages/db/src/einvoice/redact.ts
//
// ADR 0053: what may reach `einvoice_transmission.response`. The row is audited, so a credential
// stored here is copied into app.audit_log for the retention period — which is why this is a
// whitelist of SHAPE and a blacklist of NAME, not a pass-through.

/** The runtime twin of §4.2.3's FORBIDDEN_LOG_FIELD, applied to a stored value rather than a log
 *  field. Deliberately the same pattern: two spellings of "what must never be persisted" is how
 *  one of them drifts. `FORBIDDEN_LOG_FIELD` itself lives in @dulja/contracts, which packages/db
 *  may not import (§3.1), so the pattern is restated here with this comment as its provenance. */
const FORBIDDEN_KEY = /token|password|authorization|card|pin|secret/i;

export const REDACTED = "[redacted]";
const MAX_STRING = 1024;
const MAX_ARRAY = 50;
const MAX_DEPTH = 6;

/**
 * Project a remote response into something safe, bounded and diagnosable.
 *   - a key whose NAME matches FORBIDDEN_KEY becomes "[redacted]" at every depth;
 *   - a string longer than 1024 characters is truncated with a marker;
 *   - an array longer than 50 keeps 50 and says how many were dropped;
 *   - a non-object body (HTML from a proxy, an empty 502) becomes `{ nonJson: true, length }`,
 *     because "the authority replied with something that is not our contract" is exactly the
 *     diagnosis an operator needs and dropping it loses that;
 *   - anything deeper than six levels becomes "[depth]".
 */
export function redactResponse(
  raw: unknown,
  httpStatus: number,
  sensitiveValues: readonly string[] = [],
): Record<string, unknown> {
  if (typeof raw === "string") {
    return { httpStatus, body: { nonJson: true, length: raw.length } };
  }
  if (raw === null || typeof raw !== "object") {
    return { httpStatus, body: { nonJson: true, length: 0 } };
  }
  return { httpStatus, body: walk(raw, 0, sensitiveValues) };
}

function walk(node: unknown, depth: number, sensitiveValues: readonly string[]): unknown {
  if (depth > MAX_DEPTH) return "[depth]";
  if (node === null) return null;
  if (typeof node === "string") {
    const clean = redactText(node, sensitiveValues);
    return clean.length > MAX_STRING ? `${clean.slice(0, MAX_STRING)}…[truncated]` : clean;
  }
  if (typeof node === "number" || typeof node === "boolean") return node;
  if (typeof node === "bigint") return node.toString();
  if (Array.isArray(node)) {
    if (node.length <= MAX_ARRAY) return node.map((item) => walk(item, depth + 1, sensitiveValues));
    return [
      ...node.slice(0, MAX_ARRAY).map((item) => walk(item, depth + 1, sensitiveValues)),
      `…[${node.length - MAX_ARRAY} more]`,
    ];
  }
  if (typeof node !== "object") return "[unsupported]";
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    out[redactText(key, sensitiveValues)] = FORBIDDEN_KEY.test(key)
      ? REDACTED
      : walk(value, depth + 1, sensitiveValues);
  }
  return out;
}

/** Remove known credentials even when a remote service echoes them under an innocent key. */
export function redactText(text: string, sensitiveValues: readonly string[]): string {
  for (const value of sensitiveValues) {
    if (value) text = text.split(value).join(REDACTED);
  }
  return text;
}
