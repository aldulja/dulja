import { createPublicKey, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { enrolDevice, forgetDevice, loadDevice, type DeviceStore } from "../src/main/device";

function memoryStore(): DeviceStore & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    async get(key) {
      return values.get(key) ?? null;
    },
    async set(key, value) {
      values.set(key, value);
    },
    async remove(key) {
      values.delete(key);
    },
  };
}
const terminalId = "019aaadb-0000-7000-8000-000000000001";
const branchId = "019aaadb-0000-7000-8000-000000000002";
const companyId = "019aaadb-0000-7000-8000-000000000003";

describe("device identity", () => {
  it("redeems without actor headers and restores the same Ed25519 identity from one encrypted value", async () => {
    const store = memoryStore();
    let key = "";
    const device = await enrolDevice(store, {
      baseUrl: "https://api.example",
      code: "A".repeat(32),
      fetch: async (input, init) => {
        expect(new URL(String(input)).pathname).toBe("/v1/sync/enrol");
        const headers = new Headers(init?.headers);
        for (const forbidden of ["X-Tenant-Id", "X-Actor-Id", "Authorization", "Idempotency-Key"])
          expect(headers.has(forbidden)).toBe(false);
        key = (JSON.parse(String(init?.body)) as { devicePublicKey: string }).devicePublicKey;
        return Response.json({ terminalId, branchId, companyId }, { status: 201 });
      },
    });
    expect(store.values.size).toBe(1);
    const restored = await loadDevice(store);
    expect(restored?.terminalId).toBe(terminalId);
    expect(restored?.publicKeyDer).toEqual(device.publicKeyDer);
    const bytes = new TextEncoder().encode("identity survives restart");
    expect(
      verify(
        null,
        bytes,
        createPublicKey({ key: Buffer.from(key, "base64"), format: "der", type: "spki" }),
        restored!.sign(bytes),
      ),
    ).toBe(true);
    await forgetDevice(store);
    expect(await loadDevice(store)).toBeNull();
  });

  it("does not overwrite a prior identity when redemption or secure persistence fails", async () => {
    const store = memoryStore();
    store.values.set("dulja.pos.identity", "old encrypted identity");
    await expect(
      enrolDevice(store, {
        baseUrl: "https://api.example",
        code: "A".repeat(32),
        fetch: async () =>
          Response.json({ code: "ERR_TERMINAL_ENROLMENT_INVALID" }, { status: 422 }),
      }),
    ).rejects.toThrow("ERR_TERMINAL_ENROLMENT_INVALID");
    expect(store.values.get("dulja.pos.identity")).toBe("old encrypted identity");
    const refusing = {
      ...store,
      async set() {
        throw new Error("keyring unavailable");
      },
    };
    await expect(
      enrolDevice(refusing, {
        baseUrl: "https://api.example",
        code: "A".repeat(32),
        fetch: async () => Response.json({ terminalId, branchId, companyId }, { status: 201 }),
      }),
    ).rejects.toThrow("keyring unavailable");
    expect(store.values.get("dulja.pos.identity")).toBe("old encrypted identity");
    expect(await loadDevice(store)).toBeNull();
  });
});
