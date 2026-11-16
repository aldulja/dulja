# Rotating the HR field-encryption key

ADR 0080; spec:2273; contracts §3.11 (8D A1). Every `app.employee_sensitive.*_enc` value is sealed under
`HR_FIELD_ENCRYPTION_KEY` with its version in the first byte (ADR 0071). Rotation re-seals every value under a new key
with the `hr.encryption_key.rotate` job. **Never replace the key without binding the old one as
`HR_FIELD_ENCRYPTION_KEY_PREVIOUS`** — a replaced key makes every sealed value unreadable.

Commands are for staging; add `--env production` to each `wrangler` call for production.

## 1. Read the current version

`HR_FIELD_ENCRYPTION_KEY_VERSION` is `1` when unbound. Confirm what the rows carry, as the migrator (RLS forced):

```bash
psql "$DATABASE_URL_MIGRATOR" -c "select tenant_id, key_version, count(*) from app.employee_sensitive group by 1, 2 order by 1, 2"
```

Every row should be at the current version `N` before a new rotation starts. A row below it means an earlier rotation
did not finish: finish it (step 4) first.

## 2. Bind the new key, the old key and the new version

Copy the current key value out of the deployment's secret store first — Cloudflare does not show a secret back.

```bash
# The old key becomes the previous one (paste the current value when prompted).
wrangler secret put HR_FIELD_ENCRYPTION_KEY_PREVIOUS --config infra/wrangler.jsonc
# The new key: base64 of exactly 32 bytes, which both containers check at boot.
openssl rand -base64 32 | tr -d '\n' | wrangler secret put HR_FIELD_ENCRYPTION_KEY --config infra/wrangler.jsonc
# The new version: the current one plus one (2 for the first rotation), at most 255.
printf '2' | wrangler secret put HR_FIELD_ENCRYPTION_KEY_VERSION --config infra/wrangler.jsonc
```

Keep the new key in the deployment's secret store at once: a lost key is lost HR identity data.

## 3. Deploy

Deploy as usual (`docs/runbooks/deploy.md`). Both containers boot with the three names (the edge forwards all three to
the api and the worker); either refuses to start, naming the variable, on a malformed key, a version outside 1–255, or a
previous key beside version 1. From now on the API seals new writes under the new key and opens old values under the
previous one.

## 4. Enqueue the rotation, once per tenant

The job has no route and no schedule (ADR 0080, owner question 2). Enqueue it with pg-boss from the repository, as
`bun run --cwd apps/worker jobs:install` reaches the queue — once per tenant (`tenantId` from step 1; `batchSize`
optional, default 200, at most 5 000; `companyId` optional):

```bash
cd apps/worker && TENANT_ID='<tenant id>' bun -e '
import { PgBoss } from "pg-boss";
const boss = new PgBoss({ connectionString: process.env.DATABASE_URL_MIGRATOR, schema: "pgboss" });
await boss.start();
const envelope = { tenantId: process.env.TENANT_ID, requestId: crypto.randomUUID(), payload: {} };
console.log(await boss.send("hr.encryption_key.rotate", envelope));
await boss.stop();'
```

The worker logs one `hr_key_rotation_complete` line per run with
`scanned`, `rotated`, `batches` and `key_version`; an `hr_key_rotation_incomplete` warning means the run stopped at its
batch bound — enqueue it again. A failed run (`HrKeyError`) means a value is sealed under a version the ring does not
carry: stop and check step 2's bindings; nothing was written by the failed batch.

## 5. Verify — the gate on step 6

```bash
psql "$DATABASE_URL_MIGRATOR" -c "select tenant_id, key_version, count(*) from app.employee_sensitive group by 1, 2 order by 1, 2"
```

Every row must be at the new version. Enqueue the job once more for each tenant and confirm its line reports
`scanned: 0`.

## 6. Retire the previous key

Only after step 5 shows no row below the new version:

```bash
wrangler secret delete HR_FIELD_ENCRYPTION_KEY_PREVIOUS --config infra/wrangler.jsonc
```

Deploy again. Leave `HR_FIELD_ENCRYPTION_KEY_VERSION` bound at the new version: unbound, both containers would read
version 1, and every row — now sealed at the new version — would name a version the ring no longer holds.
