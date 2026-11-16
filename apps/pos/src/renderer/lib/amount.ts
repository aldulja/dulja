import { Money, Quantity, type CurrencyCode } from "@dulja/domain";
import type { TranslationKey } from "@dulja/i18n";

/**
 * A typed figure the till cannot read. Its message carries `ERR_VALIDATION_FAILED`, so the screen shows the
 * validation refusal and never the internal-fault message (UI-14), and `field` names the field to fix.
 */
export class FieldError extends Error {
  constructor(
    readonly field: TranslationKey,
    detail: string,
  ) {
    super(`ERR_VALIDATION_FAILED: ${detail}`);
    this.name = "FieldError";
  }
}

const ARABIC_INDIC = /[٠-٩]/g;
const EXTENDED_ARABIC_INDIC = /[۰-۹]/g;

/**
 * The figure as the domain reads it: trimmed, Arabic-Indic and Persian digits as Western ones, and the Arabic
 * decimal separator or a decimal comma as a point. A comma followed by exactly three digits (`1,000`) could be a
 * thousands separator, which would read a thousand as one, so it is refused rather than guessed.
 */
function normalise(text: string, field: TranslationKey): string {
  let value = text
    .trim()
    .replace(ARABIC_INDIC, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(EXTENDED_ARABIC_INDIC, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/٫/g, ".");
  if (value.includes(",")) {
    if (value.includes(".") || /,\d{3}$/.test(value))
      throw new FieldError(field, `"${text}" is ambiguous: use a point for decimals`);
    value = value.replace(",", ".");
  }
  return value;
}

/** A money field. An empty optional field (a discount) is none; an empty required one is refused. */
export function parseMoney<C extends CurrencyCode>(
  text: string,
  ccy: C,
  field: TranslationKey,
  { emptyIsZero = false }: { emptyIsZero?: boolean } = {},
): Money<C> {
  const value = normalise(text, field);
  if (value === "") {
    if (emptyIsZero) return Money.zero(ccy);
    throw new FieldError(field, "an amount is required");
  }
  try {
    return Money.of(value, ccy);
  } catch {
    throw new FieldError(field, `"${text}" is not an amount of at most four decimals`);
  }
}

export function parseQuantity(text: string, field: TranslationKey): Quantity {
  const value = normalise(text, field);
  try {
    return Quantity.of(value);
  } catch {
    throw new FieldError(field, `"${text}" is not a quantity`);
  }
}

/** The most integer digits a typed till amount may have: a longer figure is a barcode, not cash (UI-02). */
export const MAX_AMOUNT_DIGITS = 9;
/** A run of characters this long or longer, typed faster than this per key, is a scanner, not a person. */
export const SCAN_MIN_CHARACTERS = 4;
export const SCAN_MAX_MEAN_GAP_MS = 30;

/**
 * Watches one amount field's keystrokes (UI-02). A keyboard-wedge scanner types a whole code and Enter within a
 * few milliseconds; a person takes far longer per key. `looksScanned` answers whether what the field now holds
 * arrived that way, or is too long to be a till amount at all. Call `reset` whenever the field is emptied.
 */
export function createScanGuard(now: () => number = () => performance.now()) {
  let times: number[] = [];
  return {
    onKeyDown(event: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean }) {
      if (event.key.length !== 1 || event.ctrlKey || event.metaKey || event.altKey) return;
      times.push(now());
    },
    reset() {
      times = [];
    },
    looksScanned(value: string): boolean {
      const integer = value.trim().split(/[.,٫]/)[0] ?? "";
      if (integer.replace(/\D/g, "").length > MAX_AMOUNT_DIGITS) return true;
      const recent = times.slice(-value.trim().length);
      if (recent.length < SCAN_MIN_CHARACTERS) return false;
      const mean = (recent.at(-1)! - recent[0]!) / (recent.length - 1);
      return mean < SCAN_MAX_MEAN_GAP_MS;
    },
  };
}
