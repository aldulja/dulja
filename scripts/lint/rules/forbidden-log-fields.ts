import type { LintRule, LintViolation } from "../types";

const CALL = /\b(?:logger|log|c\.var\.logger)\.(?:debug|info|warn|error)\(\s*\{([^}]*)\}/;
const FORBIDDEN = /\b\w*(token|password|authorization|card|pin|secret)\w*\b/i;

export const rule: LintRule = {
  name: "forbidden-log-fields",
  run(files) {
    const violations: LintViolation[] = [];
    for (const file of files) {
      if (!/^(apps|packages)\//.test(file.path)) continue;
      // Runtime logger tests intentionally pass secret-shaped fields to prove they are redacted.
      if (/(^|\/)test\//.test(file.path) || /\.test\.tsx?$/.test(file.path)) continue;
      file.lines.forEach((line, index) => {
        const match = CALL.exec(line);
        if (!match) return;
        for (const field of match[1]!.split(",")) {
          const name = field.split(":")[0]?.trim() ?? "";
          if (name && FORBIDDEN.test(name))
            violations.push({
              file: file.path,
              line: index + 1,
              rule: this.name,
              detail: `log field ${JSON.stringify(name)} may carry a credential`,
            });
        }
      });
    }
    return violations;
  },
};
