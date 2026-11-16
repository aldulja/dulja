import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  CanonicalJsonError,
  EInvoiceProfileError,
  isTransmissionStatus,
  mapRemoteStatus,
  parseProfile,
  renderPath,
  resolvePointer,
  TRANSMISSION_STATUSES,
  type EInvoiceCallSpec,
} from "../../src/tax/einvoice";

const GOOD_PROFILE = {
  code: "synthetic",
  version: 1,
  jurisdiction: "MY",
  source: "slice 5B, Task 4 — a loopback stub. Not an authority.",
  baseUrl: "http://127.0.0.1:1/",
  timeoutMs: 5000,
  auth: {
    kind: "bearer",
    header: "Authorization",
    scheme: "Bearer",
    clientIdHeader: "X-Client-Id",
  },
  calls: {
    submit: {
      method: "POST",
      pathTemplate: "/documents",
      body: "document",
      externalIdPointer: "/id",
      statusPointer: "/state",
      statusMap: { queued: "submitted", ok: "accepted", refused: "rejected" },
      errorPointer: "/message",
    },
    poll: {
      method: "GET",
      pathTemplate: "/documents/{externalId}",
      body: "none",
      statusPointer: "/state",
      statusMap: { queued: "submitted", ok: "accepted", refused: "rejected" },
    },
    cancel: {
      method: "POST",
      pathTemplate: "/documents/{externalId}/cancel",
      body: "cancellation",
      statusPointer: "/state",
      statusMap: { void: "cancelled" },
    },
  },
} as const;

describe("§4.9.3 — TransmissionStatus", () => {
  it("is exactly the six labels of the contracts registry, in registry order", () => {
    expect(TRANSMISSION_STATUSES).toEqual([
      "pending",
      "submitted",
      "accepted",
      "rejected",
      "cancelled",
      "error",
    ]);
  });

  it("narrows a string and refuses anything else", () => {
    expect(isTransmissionStatus("accepted")).toBe(true);
    expect(isTransmissionStatus("posted")).toBe(false);
    expect(isTransmissionStatus(undefined)).toBe(false);
  });
});

describe("canonicalJson — the one deterministic serialiser (spec:2264, test 26)", () => {
  it("sorts object keys at every depth and emits no whitespace", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it("keeps array order, which is line order", () => {
    expect(canonicalJson([{ b: 1, a: 2 }, 3])).toBe('[{"a":2,"b":1},3]');
  });

  it("is byte-identical across two calls on structurally equal inputs built in different key order", () => {
    const left = { total: { amount: "10.0000", currency: "MYR" }, lineNo: 1 };
    const right = { lineNo: 1, total: { currency: "MYR", amount: "10.0000" } };
    expect(canonicalJson(left)).toBe(canonicalJson(right));
  });

  it("omits an undefined value rather than emitting null (a key that is absent stays absent)", () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it("renders a bigint as its decimal string (document.number is bigint | null)", () => {
    expect(canonicalJson({ number: 42n })).toBe('{"number":"42"}');
  });

  it("REFUSES a non-integer number — money is a string on this path (Global Constraint 4, SAH-019)", () => {
    expect(() => canonicalJson({ amount: 10.5 })).toThrow(CanonicalJsonError);
    expect(() => canonicalJson({ amount: 10.5 })).toThrow(/non-integer number at \/amount/);
  });

  it("REFUSES NaN, Infinity, a Date, a Map and a function, each naming its path", () => {
    expect(() => canonicalJson({ a: Number.NaN })).toThrow(/non-finite number at \/a/);
    expect(() => canonicalJson([1, Number.POSITIVE_INFINITY])).toThrow(/non-finite number at \/1/);
    expect(() => canonicalJson({ at: new Date(0) })).toThrow(/unsupported value at \/at/);
    expect(() => canonicalJson({ m: new Map() })).toThrow(/unsupported value at \/m/);
    expect(() => canonicalJson({ f: () => 1 })).toThrow(/unsupported value at \/f/);
  });

  it("REFUSES a cycle rather than recursing (a snapshot is a tree; a cycle is a caller defect)", () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    expect(() => canonicalJson(cyclic)).toThrow(/cycle at \/self/);
  });
});

describe("resolvePointer — RFC 6901", () => {
  it("walks objects and arrays", () => {
    expect(resolvePointer({ a: { b: [10, 20] } }, "/a/b/1")).toBe(20);
  });
  it("decodes ~1 as / and ~0 as ~, in that order", () => {
    expect(resolvePointer({ "a/b": 1, "c~d": 2 }, "/a~1b")).toBe(1);
    expect(resolvePointer({ "a/b": 1, "c~d": 2 }, "/c~0d")).toBe(2);
  });
  it("returns undefined for a missing member rather than throwing", () => {
    expect(resolvePointer({ a: 1 }, "/b")).toBeUndefined();
    expect(resolvePointer({ a: [1] }, "/a/9")).toBeUndefined();
    expect(resolvePointer(null, "/a")).toBeUndefined();
  });
});

describe("renderPath", () => {
  it("substitutes and percent-encodes every variable", () => {
    expect(renderPath("/documents/{externalId}", { externalId: "a b/c" })).toBe(
      "/documents/a%20b%2Fc",
    );
  });
  it("throws on a placeholder with no variable, naming it", () => {
    expect(() => renderPath("/documents/{missing}", {})).toThrow(/no value for {missing}/);
  });
  it("throws on a variable the template does not use, naming it — an unused variable is a profile bug", () => {
    expect(() => renderPath("/documents", { externalId: "x" })).toThrow(
      /unused variable externalId/,
    );
  });
});

describe("mapRemoteStatus", () => {
  const spec = GOOD_PROFILE.calls.submit as unknown as EInvoiceCallSpec;

  it("maps a known remote label", () => {
    expect(mapRemoteStatus(spec, { state: "ok" })).toEqual({ status: "accepted", unmapped: null });
  });
  it("maps an UNKNOWN remote label to error and reports it, rather than throwing", () => {
    expect(mapRemoteStatus(spec, { state: "in_review" })).toEqual({
      status: "error",
      unmapped: "in_review",
    });
  });
  it("maps a missing status member to error and reports the absence", () => {
    expect(mapRemoteStatus(spec, { other: 1 })).toEqual({ status: "error", unmapped: "<absent>" });
  });
  it("stringifies a non-string remote label before looking it up", () => {
    const numeric = { ...spec, statusMap: { "200": "accepted" } } as unknown as EInvoiceCallSpec;
    expect(mapRemoteStatus(numeric, { state: 200 })).toEqual({
      status: "accepted",
      unmapped: null,
    });
  });
});

describe("parseProfile — the JSON Schema is the contract (ADR 0052)", () => {
  it("accepts a conforming profile and returns it typed", () => {
    const p = parseProfile(structuredClone(GOOD_PROFILE));
    expect(p.code).toBe("synthetic");
    expect(p.calls.submit.method).toBe("POST");
  });

  it("refuses an unknown transmitter code, naming the path", () => {
    const bad = { ...structuredClone(GOOD_PROFILE), code: "zatca" };
    expect(() => parseProfile(bad)).toThrow(EInvoiceProfileError);
    try {
      parseProfile(bad);
    } catch (e) {
      expect((e as EInvoiceProfileError).errors.map((x) => x.path)).toContain("/code");
    }
  });

  it("refuses a missing call, an unknown call, and an unknown property anywhere", () => {
    const noCancel = structuredClone(GOOD_PROFILE) as Record<string, unknown>;
    delete (noCancel.calls as Record<string, unknown>).cancel;
    expect(() => parseProfile(noCancel)).toThrow(/\/calls/);

    const extraCall = structuredClone(GOOD_PROFILE) as Record<string, unknown>;
    (extraCall.calls as Record<string, unknown>).batch = structuredClone(GOOD_PROFILE.calls.submit);
    expect(() => parseProfile(extraCall)).toThrow(/\/calls/);

    const extraProp = { ...structuredClone(GOOD_PROFILE), retryAfterHeader: "Retry-After" };
    expect(() => parseProfile(extraProp)).toThrow(/retryAfterHeader/);
  });

  it("refuses a statusMap value outside the six labels", () => {
    const bad = structuredClone(GOOD_PROFILE) as Record<string, unknown>;
    (
      bad.calls as Record<string, Record<string, Record<string, string>>>
    ).submit!.statusMap!.queued = "posted";
    expect(() => parseProfile(bad)).toThrow(/statusMap/);
  });

  it("refuses a non-loopback, non-http base URL and an empty statusMap", () => {
    expect(() => parseProfile({ ...structuredClone(GOOD_PROFILE), baseUrl: "ftp://x/" })).toThrow(
      /baseUrl/,
    );
    const empty = structuredClone(GOOD_PROFILE) as Record<string, unknown>;
    (empty.calls as Record<string, Record<string, unknown>>).submit!.statusMap = {};
    expect(() => parseProfile(empty)).toThrow(/statusMap/);
  });

  it("refuses a path template that is not a rooted path (no host may hide in it)", () => {
    const bad = structuredClone(GOOD_PROFILE) as Record<string, unknown>;
    (bad.calls as Record<string, Record<string, unknown>>).submit!.pathTemplate =
      "http://elsewhere/x";
    expect(() => parseProfile(bad)).toThrow(/pathTemplate/);
  });

  it("refuses an auth kind outside the reviewed bearer/OAuth vocabulary", () => {
    const bad = structuredClone(GOOD_PROFILE) as Record<string, unknown>;
    (bad.auth as Record<string, unknown>).kind = "hmac";
    expect(() => parseProfile(bad)).toThrow(/\/auth\/kind/);
  });

  it("accepts client-credentials OAuth without storing client credentials in the profile", () => {
    const auth = {
      kind: "oauth2_client_credentials",
      header: "Authorization",
      tokenUrl: "https://identity.example.test/connect/token",
      scope: "InvoicingAPI",
    };
    expect(parseProfile({ ...GOOD_PROFILE, auth }).auth).toEqual(auth);
    expect(() =>
      parseProfile({ ...GOOD_PROFILE, auth: { ...auth, clientSecret: "secret" } }),
    ).toThrow(/auth/);
    expect(() =>
      parseProfile({ ...GOOD_PROFILE, auth: { ...auth, clientIdHeader: "X-Id" } }),
    ).toThrow(/auth/);
  });

  it("requires the OAuth token URL and confines plain HTTP to the local test host", () => {
    const auth = { kind: "oauth2_client_credentials", header: "Authorization" };
    expect(() => parseProfile({ ...GOOD_PROFILE, auth })).toThrow(/tokenUrl/);
    for (const tokenUrl of [
      "http://identity.example.test/connect/token",
      "https://user:password@identity.example.test/connect/token",
      "https://identity.example.test/connect/token?secret=value",
      "https://identity.example.test/connect/token#fragment",
    ])
      expect(() => parseProfile({ ...GOOD_PROFILE, auth: { ...auth, tokenUrl } })).toThrow(
        /tokenUrl/,
      );
    expect(() =>
      parseProfile({
        ...GOOD_PROFILE,
        auth: { ...auth, tokenUrl: "http://127.0.0.1:12345/connect/token" },
      }),
    ).not.toThrow();
  });

  it("caps timeoutMs at 60000 — one call must end well inside the transmission claim window", () => {
    // One deadline bounds the whole call (token fetch, request, 401 retry), and the transmission
    // log lets another caller take the claim over once it is 120 s old. The schema's maximum is half
    // that window; packages/db/test/einvoice/profile.test.ts pins the relation to the constant.
    expect(parseProfile({ ...structuredClone(GOOD_PROFILE), timeoutMs: 60_000 }).timeoutMs).toBe(
      60_000,
    );
    for (const timeoutMs of [60_001, 120_000]) {
      let refusal: unknown;
      try {
        parseProfile({ ...structuredClone(GOOD_PROFILE), timeoutMs });
      } catch (e) {
        refusal = e;
      }
      expect(refusal, `timeoutMs ${timeoutMs} was accepted`).toBeInstanceOf(EInvoiceProfileError);
      expect((refusal as EInvoiceProfileError).errors).toContainEqual({
        path: "/timeoutMs",
        message: "must be <= 60000",
      });
    }
  });

  it("refuses a profile with no source — a profile whose values cite nothing is a guess (hazard 2)", () => {
    const bad = structuredClone(GOOD_PROFILE) as Record<string, unknown>;
    delete bad.source;
    expect(() => parseProfile(bad)).toThrow(/source/);
  });

  it("refuses a submit call with no externalIdPointer — the CHECK in 0057 makes it mandatory", () => {
    // `einvoice_transmission_external_id_check` (Task 1) refuses status submitted/accepted/cancelled
    // with a null `external_id`. A profile whose submit call names no pointer would therefore make
    // `submitTransmission` raise a raw SQLSTATE 23514 from inside a worker job, past every typed
    // EInvoiceError. The schema is where that is caught, not the database.
    const bad = structuredClone(GOOD_PROFILE) as Record<string, unknown>;
    delete (bad.calls as Record<string, Record<string, unknown>>).submit!.externalIdPointer;
    expect(() => parseProfile(bad)).toThrow(/externalIdPointer/);
  });

  it("does NOT require externalIdPointer on a call that sends no document, even with `body` omitted", () => {
    // The clause is `if body === "document"` with `required: ["body"]`, so a call that omits `body`
    // altogether (the "none" default) is untouched by it. GOOD_PROFILE's poll and cancel already
    // carry no externalIdPointer, which is what makes this the negative half of the pair.
    const ok = structuredClone(GOOD_PROFILE) as Record<string, unknown>;
    const poll = (ok.calls as Record<string, Record<string, unknown>>).poll!;
    expect(poll.externalIdPointer).toBeUndefined();
    delete poll.body;
    expect(() => parseProfile(ok)).not.toThrow();
  });
});
