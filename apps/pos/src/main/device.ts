import { EnrolResultSchema } from "@dulja/contracts/sync/enrolment";
import {
  createPublicKey,
  generateKeyPairSync,
  sign as edSign,
  createPrivateKey,
} from "node:crypto";
import { TillError } from "./errors";
import { TILL_REQUEST_TIMEOUT_MS } from "./transport";

/**
 * The terminal's device identity (§4.10.3, spec:1322).
 *
 * The private key never leaves this module and never reaches the renderer: `DeviceStore` is 0E's
 * `SecureStore` shape (`safeStorage`-backed), injected rather than imported so this module is testable
 * without Electron and so `apps/pos` does not import `apps/desktop` (spec:2389).
 */
export interface DeviceIdentity {
  terminalId: string;
  branchId?: string;
  companyId?: string;
  publicKeyDer: Buffer;
  sign(message: Uint8Array): Uint8Array;
}

export interface DeviceStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

const KEY_IDENTITY = "dulja.pos.identity"; // one encrypted value prevents mixed key/terminal pairs

function identityFrom(
  terminalId: string,
  pem: string,
  scope?: { branchId: string; companyId: string },
): DeviceIdentity {
  const privateKey = createPrivateKey({ key: pem, format: "pem", type: "pkcs8" });
  return {
    terminalId,
    ...scope,
    publicKeyDer: createPublicKey(privateKey).export({ type: "spki", format: "der" }),
    sign: (message) => edSign(null, Buffer.from(message), privateKey),
  };
}

export async function loadDevice(store: DeviceStore): Promise<DeviceIdentity | null> {
  const value = await store.get(KEY_IDENTITY);
  if (value === null) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("terminalId" in parsed) ||
      !("pem" in parsed) ||
      typeof parsed.terminalId !== "string" ||
      typeof parsed.pem !== "string"
    )
      return null;
    const scope =
      "branchId" in parsed &&
      "companyId" in parsed &&
      typeof parsed.branchId === "string" &&
      typeof parsed.companyId === "string"
        ? { branchId: parsed.branchId, companyId: parsed.companyId }
        : undefined;
    return identityFrom(parsed.terminalId, parsed.pem, scope);
  } catch {
    return null;
  }
}

/**
 * Redeems a one-time enrolment code (§4.10.3). `POST /v1/sync/enrol` is 6A's **public** route: it carries no
 * signature (there is no key yet) and no `Idempotency-Key` (a public route has no tenant to key on — 6A's
 * amendment 21), and it is idempotent in its own right because redemption is
 * `update … set redeemed_at = now() where redeemed_at is null returning …`.
 *
 * The keypair is generated **before** the call and the private half is persisted **after** a 201: a key
 * written first and then orphaned by a failed redemption is a key the shop cannot tell from a live one.
 */
export async function enrolDevice(
  store: DeviceStore,
  opts: { baseUrl: string; code: string; fetch?: typeof fetch; timeoutMs?: number },
): Promise<DeviceIdentity> {
  const doFetch = opts.fetch ?? fetch;
  // Bounded like every till request (POS-03): the renderer holds enrolment's form busy until this settles.
  const signal = AbortSignal.timeout(opts.timeoutMs ?? TILL_REQUEST_TIMEOUT_MS);
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const devicePublicKey = publicKey.export({ type: "spki", format: "der" }).toString("base64");
  const response = await doFetch(new URL("/v1/sync/enrol", opts.baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: opts.code, devicePublicKey }),
    signal,
  });
  if (!response.ok) {
    const problem = (await response.json().catch(() => ({}))) as { code?: string; detail?: string };
    // The server's refusal of the code itself crosses the bridge as its own code, so the screen can say the
    // code is expired or used. Anything else stays an untyped fault: the till shows its general message.
    if (problem.code === "ERR_TERMINAL_ENROLMENT_INVALID")
      throw new TillError(problem.code, problem.detail ?? "enrolment code refused");
    throw new Error(
      `${problem.code ?? `HTTP_${response.status}`}: ${problem.detail ?? "enrolment failed"}`,
    );
  }
  const { terminalId, branchId, companyId } = EnrolResultSchema.parse(await response.json());
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  await store.set(KEY_IDENTITY, JSON.stringify({ terminalId, branchId, companyId, pem }));
  return identityFrom(terminalId, pem, { branchId, companyId });
}

/** Used by the runbook's "this till is being decommissioned" step. It does NOT clear the outbox: unsent
 *  tickets are the one piece of unrecoverable state a till holds (ADR 0057), and losing them silently on a
 *  re-enrolment is the failure the DoD sentence exists to forbid. */
export async function forgetDevice(store: DeviceStore): Promise<void> {
  await store.remove(KEY_IDENTITY);
}
