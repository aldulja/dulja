import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// `@testing-library/react`'s own auto-cleanup only registers itself when `afterEach` is already a
// global (true under Jest, or under Vitest's `test.globals: true`). This project imports test
// functions explicitly from "vitest" instead of turning on that global, so without this the render
// from one test leaks into the next within the same file — and `shell.test.tsx` renders `<AppShell>`
// three times, which would leave `getByLabelText("Language")` matching three selects.
afterEach(() => {
  cleanup();
});
