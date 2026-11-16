// apps/worker/test/boss.test.ts — code review 2026-09-29: the worker's pg-boss is born with an `error`
// listener, as the API's enqueue client is. No container: constructing a PgBoss connects to nothing.
import { describe, expect, it } from "vitest";
import { createBoss } from "../src/boss";

describe("the worker's pg-boss never throws an unhandled `error`", () => {
  it("an `error` event (an idle connection the server dropped) reaches onError and does not throw", () => {
    const seen: unknown[] = [];
    const boss = createBoss("postgres://nobody@127.0.0.1:1/none", (error) => seen.push(error));
    const dropped = new Error("Connection terminated unexpectedly");
    // An EventEmitter with no `error` listener throws the error from emit(); this one must not.
    expect(() => boss.emit("error", dropped)).not.toThrow();
    expect(seen).toEqual([dropped]);
    expect(boss.listenerCount("error")).toBe(1);
  });
});
