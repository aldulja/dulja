import { PgBoss } from "pg-boss";
import { JOB_NAMES, JOBS, queuePolicy } from "@dulja/db";

const url = process.env["DATABASE_URL_MIGRATOR"];
if (!url) {
  process.stderr.write("DATABASE_URL_MIGRATOR is not set\n");
  process.exit(2);
}
const boss = new PgBoss({ connectionString: url, schema: "pgboss", migrate: true, max: 2 });
await boss.start();
const declared: string[] = [];
for (const name of JOB_NAMES) {
  declared.push(name);
  if (JOBS[name].schedule !== null) declared.push(`${name}.fanout`);
}
for (const name of declared) {
  // `createQueue` is `INSERT … ON CONFLICT DO NOTHING` and pg-boss refuses to change a policy after creation
  // (`updateQueue` throws), so a queue that already exists under another policy is kept silently. Checked
  // rather than trusted: the two stately queues' dedupe (contracts §4.2.6) exists only if they ARE stately.
  const policy = queuePolicy(name);
  await boss.createQueue(name, { policy });
  const installed = await boss.getQueue(name);
  if (installed?.policy !== policy) {
    await boss.stop({ graceful: false });
    process.stderr.write(
      `queue ${name} exists with policy ${installed?.policy ?? "(none)"}, not ${policy}; pg-boss cannot change a policy in place — drain it, deleteQueue it and re-run this step\n`,
    );
    process.exit(1);
  }
}
await boss.stop({ graceful: false });
process.stdout.write(`pg-boss installed; ${JOB_NAMES.length} queues declared\n`);
