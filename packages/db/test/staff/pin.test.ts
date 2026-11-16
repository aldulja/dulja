import { describe, expect, it } from "vitest";
import {
  hashPin,
  verifyPin,
  PinFormatError,
  PIN_MIN_LENGTH,
  PIN_MAX_LENGTH,
} from "../../src/staff/pin";

describe("PIN hashing — the one credential the application hashes (spec:2132; SAH-028)", () => {
  it("produces a PHC-encoded argon2id string carrying its own parameters", async () => {
    const phc = await hashPin("1234");
    expect(phc.startsWith("$argon2id$")).toBe(true);
    expect(phc).toContain("m=19456");
    expect(phc).toContain("t=2");
    expect(phc).toContain("p=1");
  });

  it("salts per cashier — the same PIN twice gives two different hashes", async () => {
    expect(await hashPin("1234")).not.toBe(await hashPin("1234"));
  });

  it("verifies the right PIN and refuses the wrong one", async () => {
    const phc = await hashPin("998877");
    expect(await verifyPin("998877", phc)).toBe(true);
    expect(await verifyPin("998878", phc)).toBe(false);
  });

  it("returns false rather than throwing on a malformed stored hash", async () => {
    expect(await verifyPin("1234", "not-a-phc-string")).toBe(false);
    expect(await verifyPin("1234", "")).toBe(false);
    expect(await verifyPin("1234", "$argon2id$v=19$not-valid")).toBe(false);
  });

  it("refuses a PIN outside the length band, in the function that stores it", async () => {
    await expect(hashPin("1")).rejects.toBeInstanceOf(PinFormatError);
    await expect(hashPin("0".repeat(PIN_MAX_LENGTH + 1))).rejects.toBeInstanceOf(PinFormatError);
    await expect(hashPin("0".repeat(PIN_MIN_LENGTH))).resolves.toContain("$argon2id$");
  });

  it("refuses a non-digit PIN — a till keypad has ten keys", async () => {
    await expect(hashPin("12a4")).rejects.toBeInstanceOf(PinFormatError);
  });
});
