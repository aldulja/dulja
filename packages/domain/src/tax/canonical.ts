export class CanonicalJsonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalJsonError";
  }
}

/**
 * Deterministic JSON: object keys sorted by code unit at every depth, arrays in order, no
 * whitespace. This is what the request body and the `request_sha256` digest are both taken over,
 * so two runs over the same document produce the same bytes and the same hash — acceptance test 26
 * ("byte-identical across runs", spec:2444) extended to the transmission payload.
 *
 * Deliberately narrow about what it accepts:
 *   - a non-integer `number` is REFUSED. Every money amount on this path is `Money.toString()`'s
 *     fixed 4-dp string or `Money.toJSON()`'s `{ amount, currency }` (Global Constraint 4); a float
 *     reaching here means someone re-derived an amount, which is SAH-019 in one line.
 *   - `undefined` OMITS its key, so an absent optional stays absent rather than becoming `null`.
 *   - `bigint` becomes its decimal string, because `DocumentSnapshot.header.number` is `bigint | null`.
 *   - a `Date`, a `Map`, a `Set`, a function or a class instance is REFUSED, naming its pointer: an
 *     authority payload is a tree of scalars and plain objects, and anything else serialises
 *     differently across runtimes.
 *   - a cycle is REFUSED rather than recursed.
 */
export function canonicalJson(value: unknown): string {
  const seen = new Set<object>();

  const emit = (node: unknown, path: string): string => {
    if (node === null) return "null";

    switch (typeof node) {
      case "boolean":
        return node ? "true" : "false";
      case "string":
        return JSON.stringify(node);
      case "bigint":
        return JSON.stringify(node.toString());
      case "number":
        if (!Number.isFinite(node)) {
          throw new CanonicalJsonError(`canonicalJson: non-finite number at ${path || "/"}`);
        }
        if (!Number.isInteger(node)) {
          throw new CanonicalJsonError(
            `canonicalJson: non-integer number at ${path || "/"} — money is a string on this path (§3.9, SAH-019)`,
          );
        }
        return String(node);
      case "object":
        break;
      default:
        throw new CanonicalJsonError(`canonicalJson: unsupported value at ${path || "/"}`);
    }

    const obj = node as object;
    if (seen.has(obj)) throw new CanonicalJsonError(`canonicalJson: cycle at ${path || "/"}`);
    seen.add(obj);
    try {
      if (Array.isArray(obj)) {
        const parts = obj.map((item, i) => emit(item, `${path}/${i}`));
        return `[${parts.join(",")}]`;
      }
      if (Object.getPrototypeOf(obj) !== Object.prototype && Object.getPrototypeOf(obj) !== null) {
        throw new CanonicalJsonError(`canonicalJson: unsupported value at ${path || "/"}`);
      }
      const record = obj as Record<string, unknown>;
      const keys = Object.keys(record)
        .filter((k) => record[k] !== undefined)
        .toSorted();
      const parts = keys.map(
        (k) => `${JSON.stringify(k)}:${emit(record[k], `${path}/${escapeToken(k)}`)}`,
      );
      return `{${parts.join(",")}}`;
    } finally {
      seen.delete(obj);
    }
  };

  return emit(value, "");
}

/** RFC 6901 escaping, used only to build the pointer that appears in an error message. */
function escapeToken(token: string): string {
  return token.replace(/~/g, "~0").replace(/\//g, "~1");
}
