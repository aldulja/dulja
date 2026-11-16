import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { createJobClient, JOBS, withTenant, type JobClient } from "@dulja/db";
import { installBoss, stopBoss, seedTenant } from "@dulja/db/test";
import type { PgBoss } from "pg-boss";
import { sharedApi } from "../support/api";
import { buildTicket, posFixture, uuidv7Sync, type PosFixture } from "./support/pos";
import { posSyncApply } from "../../apps/worker/src/handlers/pos-sync-apply";
import { setJobs } from "../../apps/worker/src/jobs";

describe("queued POS apply retains terminal authority", () => {
  let f: PosFixture;
  let api: Awaited<ReturnType<typeof sharedApi>>["api"];
  let boss: PgBoss;
  let client: JobClient;
  beforeAll(async () => {
    ({ api } = await sharedApi());
    f = await posFixture(api, "POS job");
    boss = await installBoss(api.db, Object.keys(JOBS));
    client = createJobClient(boss);
    setJobs(client);
  }, 240000);
  afterAll(async () => {
    if (boss) await stopBoss(boss);
  });
  const batch = () => ({
    terminalId: f.terminal.terminalId,
    batchId: uuidv7Sync(),
    tickets: [buildTicket(f)],
    shifts: [],
    tillEvents: [],
  });
  const run = async (body: ReturnType<typeof batch>, tenantId = f.s.tenant) =>
    posSyncApply(
      api.db.rw,
      {
        tenantId,
        requestId: uuidv7Sync(),
        payload: {
          terminalId: f.terminal.terminalId,
          batch: JSON.parse(
            JSON.stringify(body, (_key, value) =>
              typeof value === "bigint" ? value.toString() : value,
            ),
          ),
        },
      },
      { tenantId, actorId: f.s.system, requestId: "discard-system" },
    );
  it("real transactional enqueue rolls back with its transaction", async () => {
    const body = batch();
    await expect(
      withTenant(
        api.db.rw,
        { tenantId: f.s.tenant, actorId: f.terminal.principalId, requestId: "rollback" },
        async (tx) => {
          await client.enqueue(
            tx,
            "pos.sync.apply",
            {
              tenantId: f.s.tenant,
              requestId: uuidv7Sync(),
              payload: { terminalId: f.terminal.terminalId, batch: { ...body, tickets: [] } },
            },
            { singletonKey: body.batchId },
          );
          throw new Error("rollback");
        },
      ),
    ).rejects.toThrow("rollback");
    expect(await boss.fetch("pos.sync.apply")).toHaveLength(0);
  });
  it("committed queued payload is claimable and executed once as the terminal", async () => {
    const body = batch();
    const payload = JSON.parse(
      JSON.stringify(body, (_key, value) => (typeof value === "bigint" ? value.toString() : value)),
    );
    const envelope = {
      tenantId: f.s.tenant,
      requestId: uuidv7Sync(),
      payload: { terminalId: f.terminal.terminalId, batch: payload },
    };
    const id = await withTenant(
      api.db.rw,
      { tenantId: f.s.tenant, actorId: f.terminal.principalId, requestId: "commit" },
      (tx) => client.enqueue(tx, "pos.sync.apply", envelope, { singletonKey: body.batchId }),
    );
    const [claimed] = await boss.fetch<typeof envelope>("pos.sync.apply");
    expect(claimed?.id).toBe(id);
    await posSyncApply(api.db.rw, claimed!.data, {
      tenantId: f.s.tenant,
      actorId: f.s.system,
      requestId: "discard",
    });
    expect(
      await api.db
        .admin`select id from app.document where client_ref=${body.tickets[0]!.clientRef}`,
    ).toHaveLength(1);
  });
  it("posts as the terminal and replays once", async () => {
    const body = batch();
    await run(body);
    await run(body);
    const rows = await api.db.admin<
      { created_by: string; posted_by: string; attributed_to: string }[]
    >`select created_by,posted_by,attributed_to from app.document where company_id=${f.s.company} and client_ref=${body.tickets[0]!.clientRef}`;
    expect(rows).toEqual([
      {
        created_by: f.terminal.principalId,
        posted_by: f.terminal.principalId,
        attributed_to: f.cashierId,
      },
    ]);
  });
  it("refuses a victim terminal in another tenant's envelope", async () => {
    const other = await seedTenant(api.db, "Job attacker");
    const body = batch();
    await expect(run(body, other.tenant)).rejects.toMatchObject({
      code: "ERR_TERMINAL_SIGNATURE_INVALID",
    });
    expect(
      await api.db
        .admin`select id from app.document where client_ref=${body.tickets[0]!.clientRef}`,
    ).toHaveLength(0);
  });
  it("revocation between queue and execution quarantines every ticket", async () => {
    const body = batch();
    await withTenant(
      api.db.rw,
      { tenantId: f.s.tenant, actorId: f.s.system, requestId: "revoke" },
      (tx) => tx`update app.pos_terminal set revoked_at=now() where id=${f.terminal.terminalId}`,
    );
    await run(body);
    expect(
      await api.db
        .admin`select id from app.document where client_ref=${body.tickets[0]!.clientRef}`,
    ).toHaveLength(0);
    const rows = await api.db.admin<
      { error_code: string; terminal_id: string }[]
    >`select error_code,terminal_id from app.needs_attention where client_ref=${body.tickets[0]!.clientRef}`;
    expect(rows).toEqual([
      { error_code: "ERR_TERMINAL_REVOKED", terminal_id: f.terminal.terminalId },
    ]);
  });
});
