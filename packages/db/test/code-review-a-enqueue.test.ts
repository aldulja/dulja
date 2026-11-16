// packages/db/test/code-review-a-enqueue.test.ts — code review 2026-09-29, stream A, A10: the API's send-only
// pg-boss is born with an `error` listener. No container: constructing a PgBoss connects to nothing.
import { describe, expect, it } from "vitest";
import { createEnqueueBoss } from "../src/jobs/enqueue";

describe("A10 — the enqueue client's pg-boss never throws an unhandled `error`", () => {
  it("an `error` event (an idle connection the server dropped) reaches onError and does not throw", () => {
    const seen: unknown[] = [];
    const boss = createEnqueueBoss("postgres://nobody@127.0.0.1:1/none", (error) =>
      seen.push(error),
    );
    const dropped = new Error("Connection terminated unexpectedly");
    // An EventEmitter with no `error` listener throws the error from emit(); this one must not.
    expect(() => boss.emit("error", dropped)).not.toThrow();
    expect(seen).toEqual([dropped]);
    expect(boss.listenerCount("error")).toBe(1);
  });
});
