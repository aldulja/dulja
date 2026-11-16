import { describe, expect, it } from "vitest";
import { canonicalJson } from "../../src/tax";

describe("canonicalJson (§4.9.3's hash input; test 26's byte-identity)", () => {
  it("sorts keys at every depth and emits no whitespace", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } })).toBe(
      '{"a":{"c":[3,{"e":5,"f":4}],"d":2},"b":1}',
    );
  });

  it("two objects differing only in key order are byte-identical", () => {
    expect(canonicalJson({ x: 1, y: 2 })).toBe(canonicalJson({ y: 2, x: 1 }));
  });

  it("array order is PRESERVED — a return's boxes are a sequence, not a set", () => {
    expect(canonicalJson([{ code: "B" }, { code: "A" }])).toBe('[{"code":"B"},{"code":"A"}]');
  });

  it("undefined members are dropped and null is kept — the two are different facts", () => {
    expect(canonicalJson({ a: undefined, b: null })).toBe('{"b":null}');
  });

  it("a nested array of objects is stable across 100 shuffles of one object's keys", () => {
    const first = canonicalJson({ boxes: [{ amount: "1.0000", code: "A", label: "A" }] });
    for (let i = 0; i < 100; i++) {
      const keys = ["amount", "code", "label"].toSorted(() => Math.random() - 0.5);
      const box: Record<string, string> = {};
      for (const k of keys) box[k] = { amount: "1.0000", code: "A", label: "A" }[k]!;
      expect(canonicalJson({ boxes: [box] })).toBe(first);
    }
  });

  it("refuses a value JSON cannot represent, rather than emitting a lossy string", () => {
    expect(() => canonicalJson({ n: Number.NaN })).toThrow(/canonicalJson: non-finite/);
    expect(() => canonicalJson({ n: 1 } as never)).not.toThrow(); // a plain number is fine (a box COUNT)
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => canonicalJson(cyclic)).toThrow(/canonicalJson: cycle/);
  });
});
