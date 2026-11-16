import type { Plugin } from "vite";

/** Matches Bun's .sql:text loader so tests and packaged CJS execute identical DDL. */
export function sqlText(): Plugin {
  return {
    name: "pos-sql-text",
    enforce: "pre",
    transform(source, id) {
      if (id.endsWith(".sql"))
        return { code: `export default ${JSON.stringify(source)};`, map: null };
      return undefined;
    },
  };
}
