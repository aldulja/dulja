import { describe, expect, it } from "vitest";
import { CATALOGUES, createI18n, DEFAULT_LOCALE, dirFor, isLocale, LOCALES } from "../src/index";

describe("locale and direction", () => {
  it("knows both locales and their directions", () => {
    expect(LOCALES).toEqual(["en", "ar"]);
    expect(DEFAULT_LOCALE).toBe("en");
    expect(dirFor("en")).toBe("ltr");
    expect(dirFor("ar")).toBe("rtl");
  });

  it("guards unknown locales", () => {
    expect(isLocale("en")).toBe(true);
    expect(isLocale("ar")).toBe(true);
    expect(isLocale("fr")).toBe(false);
    expect(isLocale(undefined)).toBe(false);
  });
});

describe("catalogues", () => {
  it("ships exactly the two catalogues, both non-empty", () => {
    expect(Object.keys(CATALOGUES).toSorted()).toEqual(["ar", "en"]);
    expect(Object.keys(CATALOGUES.en).length).toBeGreaterThan(20);
    expect(Object.keys(CATALOGUES.ar).length).toBe(Object.keys(CATALOGUES.en).length);
  });

  it("ships no Active/Expired status label — the reading they encode is wrong", () => {
    // `admin.users.status.active`/`.expired` shipped unused until the 0E final review. 0B's
    // `activeAssignments` is a bare `z.number().int()` whose invite handler creates a member holding 0,
    // so reading 0 as "expired out of the tenant" labels every freshly invited person expired —
    // `apps/backoffice/src/routes/admin/users.tsx` records that and renders `status.noRoles` /
    // `status.hasRoles` instead (`docs/ui/od-24-users-and-roles.md`). Removed from both catalogues
    // rather than left as the obvious thing to reach for, and pinned here so re-adding them fails
    // rather than quietly offering the wrong vocabulary again. Unlike `admin.users.invite`, which is
    // deliberately unused because the screen it belongs to is not sourced yet, these two are not
    // waiting on anything: they are wrong.
    for (const locale of LOCALES) {
      expect(Object.keys(CATALOGUES[locale])).not.toContain("admin.users.status.active");
      expect(Object.keys(CATALOGUES[locale])).not.toContain("admin.users.status.expired");
    }
  });

  it("uses flat dotted keys, never nested objects (ADR 0018)", () => {
    for (const locale of LOCALES) {
      for (const [key, value] of Object.entries(CATALOGUES[locale])) {
        expect(typeof value, `${locale}:${key}`).toBe("string");
      }
    }
    expect(CATALOGUES.en["admin.users.title"]).toBe("Users and roles");
  });
});

describe("createI18n", () => {
  it("resolves a dotted key literally, with no nesting separator", async () => {
    const i18n = await createI18n({ locale: "en" });
    expect(i18n.t("admin.users.title")).toBe("Users and roles");
    expect(i18n.t("app.name")).toBe("Dulja");
  });

  it("serves Arabic when the locale is ar", async () => {
    const i18n = await createI18n({ locale: "ar" });
    expect(i18n.t("admin.users.title")).toBe("المستخدمون والأدوار");
  });

  it("applies English ICU plurals", async () => {
    const i18n = await createI18n({ locale: "en" });
    expect(i18n.t("admin.users.count", { count: 0 })).toBe("No users");
    expect(i18n.t("admin.users.count", { count: 1 })).toBe("1 user");
    expect(i18n.t("admin.users.count", { count: 7 })).toBe("7 users");
  });

  it("applies Arabic ICU plurals, including the dual form", async () => {
    const i18n = await createI18n({ locale: "ar" });
    const zero = i18n.t("admin.users.count", { count: 0 });
    const one = i18n.t("admin.users.count", { count: 1 });
    const two = i18n.t("admin.users.count", { count: 2 });
    const many = i18n.t("admin.users.count", { count: 7 });
    expect(new Set([zero, one, two, many]).size).toBe(4); // ar distinguishes zero/one/two/plural
    expect(two).toContain("مستخدمان");
  });

  it("switches language on one instance without rebuilding it", async () => {
    const i18n = await createI18n({ locale: "en" });
    await i18n.changeLanguage("ar");
    expect(i18n.t("app.signOut")).toBe("تسجيل الخروج");
  });
});
