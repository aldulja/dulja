import { fullRegression, problemOf } from "../support/api";

const INJECTIONS = [
  "Robert'); drop table app.company; --",
  "'||(select auth_subject from app.principal limit 1)||'",
  "x' union select null,null,null,null --",
  "\\'; update app.company set name = 'owned'; --",
];

fullRegression("LEGACY-037", "Four procedures interpolate unescaped user strings into SQL literals", {
  "an injection string is stored and returned byte-identically, and nothing else changes": async ({
    api,
    a,
    expect,
  }) => {
    let n = 0;
    for (const evil of INJECTIONS) {
      n += 1;
      const created = await api.request({
        method: "POST",
        path: "/v1/companies",
        as: a.human,
        body: { code: `LEGACY037${n}`, name: evil, baseCurrency: "MYR" },
      });
      expect(created.status).toBe(201);
      const { id } = (await created.json()) as { id: string };

      const read = await api.request({ method: "GET", path: `/v1/companies/${id}`, as: a.human });
      expect(((await read.json()) as { name: string }).name).toBe(evil);
    }

    const [tables] = await api.db.admin<{ n: number }[]>`
      select count(*)::int as n from information_schema.tables where table_schema = 'app' and table_name = 'company'`;
    expect(tables!.n).toBe(1);
    const [owned] = await api.db.admin<
      { n: number }[]
    >`select count(*)::int as n from app.company where name = 'owned'`;
    expect(owned!.n).toBe(0);
  },

  "an injection string in a path parameter is a validation problem, not a query": async ({
    api,
    a,
    expect,
  }) => {
    const res = await api.request({
      method: "GET",
      as: a.human,
      path: `/v1/companies/${encodeURIComponent("1 or 1=1")}`,
    });
    expect(res.status).toBe(400);
    expect((await problemOf(res)).code).toBe("ERR_VALIDATION_FAILED");
  },

  "an injection string in an Idempotency-Key is a key, not a fragment": async ({
    api,
    a,
    expect,
  }) => {
    const key = "k'; delete from app.idempotency_key; --";
    const res = await api.request({
      method: "POST",
      path: "/v1/companies",
      as: a.human,
      body: { code: "LEGACY037K", name: "Key", baseCurrency: "MYR" },
      idempotencyKey: key,
    });
    expect(res.status).toBe(201);
    const [row] = await api.db.admin<
      { key: string }[]
    >`select key from app.idempotency_key where key = ${key}`;
    expect(row!.key).toBe(key);
  },
});
