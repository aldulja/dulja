import { describe, expect, it } from "vitest";
import {
  formatDate,
  formatMoney,
  formatNumber,
  formatQuantity,
  formatTimestamp,
  localeTag,
} from "../src/format";

describe("localeTag", () => {
  it("builds a BCP-47 tag with the calendar and numbering extensions", () => {
    expect(localeTag({ locale: "en" })).toBe("en-u-ca-gregory-nu-latn");
    expect(localeTag({ locale: "ar", calendar: "islamic-umalqura", numberingSystem: "arab" })).toBe(
      "ar-u-ca-islamic-umalqura-nu-arab",
    );
  });

  it("produces a tag the platform actually resolves to the requested calendar", () => {
    const tag = localeTag({ locale: "ar", calendar: "islamic-umalqura" });
    expect(new Intl.DateTimeFormat(tag).resolvedOptions().calendar).toBe("islamic-umalqura");
  });
});

describe("formatDate", () => {
  it.each(["2026-02-30", "2025-02-29", "1900-02-29", "2026-04-31", "0000-01-01", "2026-13-01"])(
    "refuses invalid calendar date %s instead of displaying a different day",
    (value) => {
      expect(() => formatDate(value, { locale: "en" })).toThrow(TypeError);
    },
  );

  it.each(["2024-02-29", "2000-02-29", "0001-01-01"])("formats valid date %s", (value) => {
    expect(() => formatDate(value, { locale: "en" })).not.toThrow();
  });

  it("formats a YYYY-MM-DD accounting date in the Gregorian calendar", () => {
    const out = formatDate("2026-01-15", { locale: "en" });
    expect(out).toContain("2026");
    expect(out).toContain("15");
  });

  it("never shifts the day across a time zone (effective_date is a date, not an instant — spec:2039)", () => {
    // Asia/Kuala_Lumpur is UTC+8; a naive `new Date("2026-01-01")` rendered in a western zone shows 31 Dec.
    for (const timeZone of ["Asia/Kuala_Lumpur", "America/Los_Angeles", "Pacific/Kiritimati"]) {
      expect(formatDate("2026-01-01", { locale: "en", timeZone })).toContain("2026");
      expect(formatDate("2026-01-01", { locale: "en", timeZone })).toContain("1");
      expect(formatDate("2026-01-01", { locale: "en", timeZone })).not.toContain("2025");
    }
  });

  it("uses Intl's dateStyle, not component options, so a single-digit day carries no leading zero", () => {
    // The house date policy, pinned rather than described: `medium` is `Intl.DateTimeFormat`'s own
    // `dateStyle`, and en-US renders 5 January as "Jan 5, 2026". A formatter built from explicit
    // component options — `{ day: "2-digit", month: "short", year: "numeric" }` — renders "Jan 05, 2026"
    // for the same date and agrees with this one only on two-digit days. Any slice that builds its own
    // `Intl.DateTimeFormat` over a value this package also formats must use `dateStyle` so the two agree.
    // Verified on Node 24.9.0 (D5's test runtime), full ICU.
    expect(formatDate("2026-01-05", { locale: "en" })).toBe("Jan 5, 2026");
    expect(formatDate("2026-01-15", { locale: "en" })).toBe("Jan 15, 2026");
  });

  it("renders the same instant in the Hijri calendar under islamic-umalqura", () => {
    const gregorian = formatDate("2026-01-15", {
      locale: "ar",
      calendar: "gregory",
      numberingSystem: "latn",
    });
    const hijri = formatDate("2026-01-15", {
      locale: "ar",
      calendar: "islamic-umalqura",
      numberingSystem: "latn",
    });
    expect(gregorian).toContain("2026");
    expect(hijri).not.toContain("2026"); // the Hijri year is not 2026
    expect(hijri).toMatch(/14\d\d/); // it is in the 1400s AH
  });
});

describe("formatNumber and formatQuantity", () => {
  it("renders Western digits under nu-latn and Arabic-Indic digits under nu-arab", () => {
    expect(formatNumber("1234", { locale: "ar", numberingSystem: "latn" })).toContain("1,234");
    // CLDR groups `ar` with U+066C ARABIC THOUSANDS SEPARATOR, so the four digits are NOT contiguous:
    // verified on Node 24.9.0, `new Intl.NumberFormat("ar-u-ca-gregory-nu-arab", …).format("1234")`
    // returns "١٬٢٣٤". Assert the digit *set* and the grouped form, never a
    // contiguous run — a `toContain("١٢٣٤")` here fails, and grouping is on for latn in the line above.
    const arab = formatNumber("1234", { locale: "ar", numberingSystem: "arab" });
    expect(arab).toBe("١٬٢٣٤");
    expect(arab).toMatch(/^[٠-٩٫٬]+$/); // Arabic-Indic digits and separators only
  });

  it("keeps quantities at six decimal places (spec:2043)", () => {
    expect(formatQuantity("2.500000", { locale: "en" })).toBe("2.500000");
  });
});

describe("formatMoney", () => {
  it("formats the wire shape at the currency's minor units", () => {
    const out = formatMoney(
      { amount: "1234.5600", currency: "MYR" },
      { locale: "en" },
      { minorUnits: 2 },
    );
    expect(out).toContain("1,234.56");
  });

  it("formats an amount larger than Number.MAX_SAFE_INTEGER exactly — proof that no float is involved", () => {
    // Number("9007199254740993.0001") === 9007199254740992 — a float path loses the last digit and the fraction.
    const out = formatMoney(
      { amount: "9007199254740993.0001", currency: "MYR" },
      { locale: "en", numberingSystem: "latn" },
      { minorUnits: 4 },
    );
    expect(out).toContain("9,007,199,254,740,993.0001");
  });

  it("keeps a negative amount negative and does not round it away", () => {
    const out = formatMoney(
      { amount: "-0.0001", currency: "MYR" },
      { locale: "en" },
      { minorUnits: 4 },
    );
    expect(out).toContain("0.0001");
    expect(out).toMatch(/[-−(]/);
  });

  it("rejects an amount that is not a plain decimal string", () => {
    expect(() => formatMoney({ amount: "1e5", currency: "MYR" }, { locale: "en" })).toThrow(
      /formatMoney: amount must be a plain decimal string, received "1e5"/,
    );
  });
});

describe("formatTimestamp", () => {
  it("renders an RFC 3339 instant in the company time zone", () => {
    const out = formatTimestamp("2026-01-15T18:30:00Z", {
      locale: "en",
      timeZone: "Asia/Kuala_Lumpur",
    });
    expect(out).toContain("16"); // 18:30 UTC is 02:30 on the 16th in UTC+8
  });
});
