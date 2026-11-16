import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The desktop renderers run under `script-src 'self'` with no `'unsafe-eval'`
 * (`apps/desktop/src/window-options.ts`) and reach this barrel through `@dulja/contracts`. Ajv compiles a schema
 * with `new Function`, so a validator compiled at import throws before React mounts and the window paints
 * nothing — what `backoffice.exe` and `pos.exe` did until the four validators were made lazy. Importing the
 * barrel must therefore construct no `Function`; each validator compiles on its first call, as before.
 */
const realFunction = globalThis.Function;

afterEach(() => {
  globalThis.Function = realFunction;
});

/** Import the barrel afresh while every `Function(...)` and `new Function(...)` is recorded, not run. */
async function importRecordingFunction(): Promise<{
  domain: typeof import("../src/index");
  bodies: string[];
}> {
  const bodies: string[] = [];
  const record = (args: unknown[]): never => {
    bodies.push(String(args.at(-1)).slice(0, 80));
    throw new EvalError("refused: 'unsafe-eval' is not allowed (test)");
  };
  vi.resetModules();
  globalThis.Function = new Proxy(realFunction, {
    apply: (_target, _this, args: unknown[]) => record(args),
    construct: (_target, args: unknown[]) => record(args),
  });
  try {
    return { domain: await import("../src/index"), bodies };
  } finally {
    globalThis.Function = realFunction;
  }
}

describe("JSON Schema validators compile on first use, never at import", () => {
  it("importing @dulja/domain under a policy that refuses eval constructs no Function", async () => {
    const { domain, bodies } = await importRecordingFunction();
    expect(bodies).toEqual([]);
    expect(typeof domain.parsePolicy).toBe("function");
  });

  it("each validator still compiles and answers on its first call", async () => {
    vi.resetModules();
    const domain = await import("../src/index");
    expect(domain.validateTaxPack({}).ok).toBe(false);
    expect(domain.validateDocumentTypeSeed({}).ok).toBe(false);
    expect(domain.validatePolicy({}, []).ok).toBe(false);
    expect(() => domain.parsePolicy({})).toThrow(domain.PolicyEvaluationError);
    expect(() => domain.parseProfile({})).toThrow(domain.EInvoiceProfileError);
    expect(
      domain.validateReportDefinition({}, { datasets: new Set(), permissions: new Set() }).ok,
    ).toBe(false);
    expect(() => domain.parseReportDefinition({})).toThrow(domain.ReportDefinitionError);
  });
});
