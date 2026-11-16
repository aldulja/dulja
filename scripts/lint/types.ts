export interface SourceFile {
  path: string;
  text: string;
  lines: string[];
}
export interface LintViolation {
  file: string;
  line: number;
  rule: string;
  detail: string;
}
export interface LintRule {
  name: string;
  run(files: SourceFile[]): LintViolation[];
}
