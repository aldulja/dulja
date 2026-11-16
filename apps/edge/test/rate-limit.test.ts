import { describe, expect, it } from "vitest";
import {
  applyRateLimit,
  ipv6Prefix64,
  networkOriginKey,
  SHARED_ORIGIN_KEY,
} from "../src/rate-limit";

const binding = (success: boolean) => ({ limit: async () => ({ success }) });
// An IPv6 documentation address stands in for CF-Connecting-IP: SAH-082 forbids IPv4 literals in source.
const ORIGIN = "2001:db8::1";
/** What `networkOriginKey` makes of ORIGIN: an IPv6 client is keyed on its /64, never its full address. */
const ORIGIN_KEY = "2001:db8:0:0::/64";

describe("apps/edge/src/rate-limit — the RateLimit-* headers of spec:2204", () => {
  it("an allowed request carries the three RateLimit headers and no Retry-After", async () => {
    const r = await applyRateLimit(binding(true), ORIGIN, { limit: 100, windowSeconds: 60 });
    expect(r.allowed).toBe(true);
    expect(r.headers).toEqual({
      "RateLimit-Limit": "100",
      "RateLimit-Remaining": "1",
      "RateLimit-Reset": "60",
    });
  });

  it("a refused request reports zero remaining and a Retry-After equal to the window", async () => {
    const r = await applyRateLimit(binding(false), ORIGIN, { limit: 100, windowSeconds: 60 });
    expect(r.allowed).toBe(false);
    expect(r.headers["RateLimit-Remaining"]).toBe("0");
    expect(r.headers["Retry-After"]).toBe("60");
  });

  it("the default policy is stated, not implicit", async () => {
    const r = await applyRateLimit(binding(true), ORIGIN);
    expect(r.headers["RateLimit-Limit"]).toBe("600");
    expect(r.headers["RateLimit-Reset"]).toBe("60");
  });
});

const request = (headers: Record<string, string>) =>
  new Request("https://api.example/v1/companies", { headers });

describe("apps/edge/src/rate-limit — networkOriginKey, the only unforgeable key", () => {
  it("keys on CF-Connecting-IP, which Cloudflare sets on ingress", () => {
    expect(networkOriginKey(request({ "CF-Connecting-IP": ORIGIN }))).toBe(ORIGIN_KEY);
    expect(networkOriginKey(request({ "CF-Connecting-IP": "203.0.113.9" }))).toBe("203.0.113.9");
  });

  it("reads nothing a caller chose — not the token, not X-Forwarded-For", () => {
    const key = networkOriginKey(
      request({
        "CF-Connecting-IP": ORIGIN,
        "X-Forwarded-For": "2001:db8::dead",
        Authorization: `Bearer ${btoa('{"alg":"RS256"}')}.${btoa('{"sub":"019250a0-forged"}')}.sig`,
      }),
    );
    expect(key).toBe(ORIGIN_KEY);
  });

  it("keys an IPv6 origin on its /64 — a client's whole prefix is one bucket, not one per address", () => {
    const one = networkOriginKey(request({ "CF-Connecting-IP": "2001:db8:abcd:1234:1::1" }));
    const two = networkOriginKey(request({ "CF-Connecting-IP": "2001:DB8:ABCD:1234:ffff:0:0:2" }));
    const other = networkOriginKey(request({ "CF-Connecting-IP": "2001:db8:abcd:1235::1" }));
    expect(one).toBe("2001:db8:abcd:1234::/64");
    expect(two).toBe(one);
    expect(other).not.toBe(one);
    expect(ipv6Prefix64("::1")).toBe("0:0:0:0::/64");
    expect(ipv6Prefix64("[fe80::1%25eth0]")).toBe("fe80:0:0:0::/64");
  });

  it("without the header everyone shares ONE bucket — fail closed, never a bucket per request", () => {
    expect(networkOriginKey(request({}))).toBe(SHARED_ORIGIN_KEY);
    expect(networkOriginKey(request({ "CF-Connecting-IP": "" }))).toBe(SHARED_ORIGIN_KEY);
    // The property that matters: repeated calls collide. A unique key here would be no limit at all.
    expect(networkOriginKey(request({}))).toBe(networkOriginKey(request({})));
  });
});
