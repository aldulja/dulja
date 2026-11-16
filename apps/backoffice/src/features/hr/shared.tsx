import { useRef, useState } from "react";
import { useAlive, useAttemptKeys } from "../reports/shared";
import { ApiError } from "../../lib/problem";

/** A refusal the server settled as "you may not see this" — rendered as a sentence, never as empty fields. */
export const isForbidden = (error: unknown): boolean =>
  error instanceof ApiError && error.problem.status === 403;

/** "Nothing recorded yet" — the sensitive record answers 404 until its first write. */
export const isNotFound = (error: unknown): boolean =>
  error instanceof ApiError && error.problem.status === 404;

/**
 * The first day of the month after `today`, as an ISO date — the default `effectiveFrom` of a new compensation line
 * or statutory profile (8A Task 13: a change normally takes effect from the next pay period). UTC, so the default
 * cannot move a day in a western zone.
 */
export function firstOfNextMonth(today: Date = new Date()): string {
  const year = today.getUTCFullYear() + (today.getUTCMonth() === 11 ? 1 : 0);
  const month = (today.getUTCMonth() + 1) % 12;
  return `${String(year).padStart(4, "0")}-${String(month + 1).padStart(2, "0")}-01`;
}

/** A typed quantity as the wire's `numeric(19,6)` string; exact, never through a float. */
export function quantityToWire(value: string): string {
  if (!/^\d{1,13}(?:\.\d{1,6})?$/.test(value)) throw new Error("Invalid quantity");
  const [whole = "", fraction = ""] = value.split(".");
  return `${whole}.${fraction.padEnd(6, "0")}`;
}

/**
 * One gesture at a time, with §4.2.9's idempotency key per gesture (the export screen's rule): a retry of the same
 * gesture after an ambiguous failure reuses its key, a definite refusal starts afresh.
 */
export function useSubmit() {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const lock = useRef(false);
  const alive = useAlive();
  const attempts = useAttemptKeys();
  async function run<T>(
    gesture: unknown,
    send: (idempotencyKey: string) => Promise<T>,
  ): Promise<T | undefined> {
    if (lock.current) return undefined;
    const key = JSON.stringify(gesture);
    lock.current = true;
    setBusy(true);
    setFailure(null);
    try {
      const result = await send(attempts.key(key));
      attempts.settle(key);
      return result;
    } catch (cause) {
      attempts.settle(key, cause);
      if (alive.current) setFailure(cause);
      return undefined;
    } finally {
      lock.current = false;
      if (alive.current) setBusy(false);
    }
  }
  return { busy, failure, setFailure, run };
}
