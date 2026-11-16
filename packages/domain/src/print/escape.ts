const HTML: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};
export function htmlEscape(value: string): string {
  return value.replace(/[&<>"']/g, (c) => HTML[c]!);
}

/** Typst treats these as markup; a document number or a party name must never become syntax. Kept beside
 *  the HTML escape although ADR 0016 admits `chromium` alone: the renderer is engine-neutral by design. */
const TYPST = new Set(["\\", "#", "$", "@", "*", "_", "`", "<", ">", '"', "[", "]"]);
export function typstEscape(value: string): string {
  let out = "";
  for (const c of value) out += TYPST.has(c) ? `\\${c}` : c;
  return out;
}
