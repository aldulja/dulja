// The top-level `import` below is what makes this a module rather than a script, which is what lets
// `declare global` augment the real global scope — so, unlike the brief's literal text, no trailing
// `export {};` is needed (and `oxlint`'s `unicorn/require-module-specifiers` refuses an empty one).
import type { DuljaBridge } from "../src/bridge-types";

declare global {
  // eslint-disable-next-line no-var
  var dulja: DuljaBridge;
  interface Window {
    dulja: DuljaBridge;
  }
}
