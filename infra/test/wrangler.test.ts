import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const raw = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "wrangler.jsonc"),
  "utf8",
);
const config = JSON.parse(
  raw
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
    .replace(/,\s*([}\]])/g, "$1"),
) as Record<string, unknown>;
const get = <T>(name: string): T => config[name] as T;
type Block = Record<string, unknown>;
const field = <T>(block: Block, name: string): T => block[name] as T;

describe("wrangler deployment contract", () => {
  it("declares both singleton classes from one root-context image", () => {
    expect(get<string>("name")).toBe("dulja-edge");
    expect(get<string>("main")).toBe("../apps/edge/src/index.ts");
    const classes =
      get<
        { class_name: string; image: string; image_build_context: string; max_instances: number }[]
      >("containers");
    expect(classes.map((entry) => entry.class_name).toSorted()).toEqual([
      "ApiContainer",
      "WorkerContainer",
    ]);
    expect(new Set(classes.map((entry) => entry.image))).toEqual(new Set(["./Dockerfile"]));
    expect(new Set(classes.map((entry) => entry.image_build_context))).toEqual(new Set([".."]));
    expect(classes.every((entry) => entry.max_instances === 1)).toBe(true);
  });
  /**
   * OPS-02 / API-04: wrangler does NOT inherit `containers`, `durable_objects`, `r2_buckets` or `ratelimits`
   * into an `env.*` block, so a production block that sets only `vars` and `routes` deploys a Worker with none
   * of them — `env.RATE_LIMIT` undefined, every request a 500 — on staging's own hostname. Every environment is
   * asserted here: the top level (staging, what `deploy-staging.yml` deploys) and each named one.
   */
  const environments = (): [string, Block][] => [
    ["staging (top level)", config],
    ...Object.entries(get<Record<string, Block>>("env")),
  ];
  it("names exactly one production environment beside the top-level staging one", () =>
    expect(Object.keys(get<Record<string, unknown>>("env"))).toEqual(["production"]));
  it("gives every environment its own single API host — the feed is a path under it", () => {
    const hosts = environments().map(([, block]) => {
      const patterns = field<{ pattern: string }[]>(block, "routes").map((route) => route.pattern);
      expect(patterns).toHaveLength(1);
      return patterns[0];
    });
    expect(new Set(hosts).size).toBe(hosts.length);
    // 0E's update-feed URL (`DULJA_UPDATE_FEED`, docs/runbooks/deploy.md) is production's host.
    expect(
      field<{ pattern: string }[]>(
        get<Record<string, Block>>("env")["production"] ?? {},
        "routes",
      )[0]?.pattern,
    ).toBe("api.dulja.example/*");
    expect(raw).not.toMatch(/updates\.dulja\.example/);
  });
  it.each(["staging (top level)", "production"])(
    "%s binds both container classes, both Durable Objects, both R2 buckets and the rate limiter",
    (name) => {
      const block = environments().find(([label]) => label === name)?.[1] ?? {};
      const classes = field<
        { class_name: string; image: string; image_build_context: string; max_instances: number }[]
      >(block, "containers");
      expect(classes?.map((entry) => entry.class_name).toSorted()).toEqual([
        "ApiContainer",
        "WorkerContainer",
      ]);
      expect(
        classes.every(
          (entry) => entry.image === "./Dockerfile" && entry.image_build_context === "..",
        ),
      ).toBe(true);
      expect(classes.every((entry) => entry.max_instances === 1)).toBe(true);
      expect(field<{ bindings: unknown[] }>(block, "durable_objects")?.bindings).toEqual([
        { name: "API", class_name: "ApiContainer" },
        { name: "WORKER", class_name: "WorkerContainer" },
      ]);
      expect(
        field<{ binding: string }[]>(block, "r2_buckets")
          ?.map((bucket) => bucket.binding)
          .toSorted(),
      ).toEqual(["ATTACHMENTS", "UPDATE_FEED"]);
      expect(field<{ name: string }[]>(block, "ratelimits")?.map((limit) => limit.name)).toEqual([
        "RATE_LIMIT",
      ]);
      expect(Object.keys(field<Record<string, unknown>>(block, "vars")).toSorted()).toEqual([
        "APP_ENV",
        "LOG_LEVEL",
      ]);
    },
  );
  it("never shares a bucket or a rate-limit namespace between environments", () => {
    const buckets = environments().flatMap(([, block]) =>
      field<{ bucket_name: string }[]>(block, "r2_buckets").map((bucket) => bucket.bucket_name),
    );
    expect(new Set(buckets).size).toBe(buckets.length);
    const namespaces = environments().flatMap(([, block]) =>
      field<{ namespace_id: string }[]>(block, "ratelimits").map((limit) => limit.namespace_id),
    );
    expect(new Set(namespaces).size).toBe(namespaces.length);
  });
  it("sets each environment's APP_ENV to its own name", () => {
    expect(get<{ APP_ENV: string }>("vars").APP_ENV).toBe("staging");
    expect(
      field<{ APP_ENV: string }>(get<Record<string, Block>>("env")["production"] ?? {}, "vars")
        .APP_ENV,
    ).toBe("production");
  });
  it("binds API and worker Durable Objects", () => {
    const durable = get<{ bindings: { name: string; class_name: string }[] }>("durable_objects");
    expect(durable.bindings).toEqual([
      { name: "API", class_name: "ApiContainer" },
      { name: "WORKER", class_name: "WorkerContainer" },
    ]);
  });
  it("pings the worker every minute", () =>
    expect(get<{ crons: string[] }>("triggers").crons).toEqual(["* * * * *"]));
  it("binds both R2 buckets", () =>
    expect(
      get<{ binding: string }[]>("r2_buckets")
        .map((bucket) => bucket.binding)
        .toSorted(),
    ).toEqual(["ATTACHMENTS", "UPDATE_FEED"]));
  it("binds the rate limiter", () =>
    expect(get<{ name: string }[]>("ratelimits")[0]?.name).toBe("RATE_LIMIT"));
  it("contains no secrets or transaction pooler URL", () => {
    expect(raw).not.toMatch(/postgres:\/\/|:6543\b|SERVICE_ROLE|password/i);
    expect(Object.keys(get<Record<string, unknown>>("vars")).toSorted()).toEqual([
      "APP_ENV",
      "LOG_LEVEL",
    ]);
  });
  it("enables Worker observability", () =>
    expect(get<{ enabled: boolean }>("observability").enabled).toBe(true));
});
