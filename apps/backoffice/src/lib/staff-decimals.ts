/** Percent entry uses exact decimal strings; no floating point enters policy values. */
export function percentToFraction(value: string): string {
  if (!/^\d{1,3}(?:\.\d{1,4})?$/.test(value)) throw new Error("Invalid percent");
  const [whole = "", fraction = ""] = value.split(".");
  const units = BigInt(whole) * 10000n + BigInt(fraction.padEnd(4, "0"));
  if (units > 1000000n) throw new Error("Invalid percent");
  return `${units / 1000000n}.${(units % 1000000n).toString().padStart(6, "0")}`;
}
export function fractionToPercent(value: string): string {
  if (!/^[01]\.\d{6}$/.test(value)) throw new Error("Invalid fraction");
  const units = BigInt(value.replace(".", ""));
  return `${units / 10000n}.${(units % 10000n).toString().padStart(4, "0")}`;
}
export function amountToWire(value: string): string {
  if (!/^\d{1,15}(?:\.\d{1,4})?$/.test(value)) throw new Error("Invalid amount");
  const [whole = "", fraction = ""] = value.split(".");
  return `${whole}.${fraction.padEnd(4, "0")}`;
}
