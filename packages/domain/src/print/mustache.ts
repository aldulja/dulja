export class TemplateError extends Error {
  readonly code = "ERR_TEMPLATE_INVALID" as const;
  constructor(detail: string) {
    super(detail);
    this.name = "TemplateError";
  }
}

type Node =
  | { kind: "text"; text: string }
  | { kind: "var"; path: string }
  | { kind: "each"; path: string; body: Node[] }
  | { kind: "if"; path: string; consequent: Node[]; otherwise: Node[] };

interface Tag {
  raw: string;
  start: number;
  end: number;
}

const PATH = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;

function tokenise(body: string): (string | Tag)[] {
  const out: (string | Tag)[] = [];
  let i = 0;
  for (;;) {
    const open = body.indexOf("{{", i);
    if (open < 0) {
      if (i < body.length) out.push(body.slice(i));
      return out;
    }
    if (open > i) out.push(body.slice(i, open));
    const close = body.indexOf("}}", open + 2);
    if (close < 0) throw new TemplateError(`unclosed {{ at offset ${open}`);
    const raw = body.slice(open + 2, close).trim();
    // `{{{ raw }}}` would begin with `{` — there is deliberately no unescaped form (ADR 0032).
    if (raw.startsWith("{")) {
      throw new TemplateError("the triple-brace raw form is not supported: every value is escaped");
    }
    out.push({ raw, start: open, end: close + 2 });
    i = close + 2;
  }
}

function parse(
  tokens: (string | Tag)[],
  at: number,
  stopper: string | null,
): { nodes: Node[]; next: number } {
  const nodes: Node[] = [];
  let i = at;
  while (i < tokens.length) {
    const t = tokens[i]!;
    if (typeof t === "string") {
      nodes.push({ kind: "text", text: t });
      i += 1;
      continue;
    }
    const raw = t.raw;

    if (stopper && (raw === stopper || raw === "else")) return { nodes, next: i };

    if (raw.startsWith("#each ")) {
      const path = raw.slice(6).trim();
      if (!PATH.test(path)) {
        throw new TemplateError(`#each expects a path, got ${JSON.stringify(path)}`);
      }
      const inner = parse(tokens, i + 1, "/each");
      const closer = tokens[inner.next];
      if (typeof closer !== "object" || closer.raw !== "/each") {
        throw new TemplateError(`unclosed #each ${path}`);
      }
      nodes.push({ kind: "each", path, body: inner.nodes });
      i = inner.next + 1;
      continue;
    }

    if (raw.startsWith("#if ")) {
      const path = raw.slice(4).trim();
      if (!PATH.test(path))
        throw new TemplateError(`#if expects a path, got ${JSON.stringify(path)}`);
      const thenPart = parse(tokens, i + 1, "/if");
      let otherwise: Node[] = [];
      let cursor = thenPart.next;
      const maybeElse = tokens[cursor];
      if (typeof maybeElse === "object" && maybeElse.raw === "else") {
        const elsePart = parse(tokens, cursor + 1, "/if");
        otherwise = elsePart.nodes;
        cursor = elsePart.next;
      }
      const closer = tokens[cursor];
      if (typeof closer !== "object" || closer.raw !== "/if") {
        throw new TemplateError(`unclosed #if ${path}`);
      }
      nodes.push({ kind: "if", path, consequent: thenPart.nodes, otherwise });
      i = cursor + 1;
      continue;
    }

    if (raw.startsWith("#") || raw.startsWith("/")) {
      throw new TemplateError(`unknown block tag {{${raw}}}`);
    }
    if (!PATH.test(raw)) throw new TemplateError(`{{${raw}}} is not a valid path`);
    nodes.push({ kind: "var", path: raw });
    i += 1;
  }
  if (stopper) throw new TemplateError(`unclosed ${stopper === "/each" ? "#each" : "#if"} block`);
  return { nodes, next: i };
}

function resolve(path: string, scopes: readonly unknown[]): unknown {
  const segments = path.split(".");
  for (let s = scopes.length - 1; s >= 0; s -= 1) {
    let current = scopes[s];
    let ok = true;
    for (const segment of segments) {
      // `Object.hasOwn`, never `in`: `in` walks the prototype chain, so `{{ constructor.name }}` would print
      // "Object" and `{{#if hasOwnProperty}}` would be truthy instead of both being "no path" errors.
      if (current === null || typeof current !== "object" || !Object.hasOwn(current, segment)) {
        ok = false;
        break;
      }
      current = (current as Record<string, unknown>)[segment];
    }
    if (ok) return current;
  }
  throw new TemplateError(`the model has no path ${path}`);
}

function stringify(value: unknown, path: string): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  throw new TemplateError(
    `${path} is a ${Array.isArray(value) ? "list" : "object"} and cannot be printed directly`,
  );
}

function truthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return value !== undefined && value !== null && value !== false && value !== "" && value !== 0;
}

function emit(
  nodes: readonly Node[],
  scopes: readonly unknown[],
  escape: (v: string) => string,
): string {
  let out = "";
  for (const node of nodes) {
    switch (node.kind) {
      case "text":
        out += node.text;
        break;
      case "var":
        out += escape(stringify(resolve(node.path, scopes), node.path));
        break;
      case "if":
        out += emit(
          truthy(resolve(node.path, scopes)) ? node.consequent : node.otherwise,
          scopes,
          escape,
        );
        break;
      case "each": {
        const list = resolve(node.path, scopes);
        if (!Array.isArray(list)) throw new TemplateError(`#each ${node.path} is not a list`);
        for (const item of list) out += emit(node.body, [...scopes, item], escape);
        break;
      }
    }
  }
  return out;
}

/**
 * The deterministic subset: `{{ path }}`, `{{#if path}}…{{else}}…{{/if}}`, `{{#each path}}…{{/each}}`.
 * There is no raw-output form and no expression language, so a template can neither emit unescaped model
 * data nor depend on anything but the model — which is what makes two renders byte-identical.
 */
export function renderTemplate(
  body: string,
  model: unknown,
  escape: (value: string) => string,
): string {
  const { nodes } = parse(tokenise(body), 0, null);
  return emit(nodes, [model], escape);
}
