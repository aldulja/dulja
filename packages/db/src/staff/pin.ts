import { argon2id, argon2Verify } from "hash-wasm";

/** ADR 0060. A till keypad has ten keys; the band is enforced here, in the function that stores the credential. */
export const PIN_MIN_LENGTH = 4;
export const PIN_MAX_LENGTH = 12;
const PIN_PATTERN = /^[0-9]+$/;

/** OWASP's Argon2id baseline. The PHC string carries them, so raising a cost rehashes on next set only. */
const PARALLELISM = 1;
const ITERATIONS = 2;
const MEMORY_SIZE_KIB = 19456;
const HASH_LENGTH = 32;
const SALT_BYTES = 16;

export class PinFormatError extends Error {
  readonly code = "ERR_VALIDATION_FAILED" as const;
  constructor(detail: string) {
    super(detail);
    this.name = "PinFormatError";
  }
}

function assertPin(pin: string): void {
  if (pin.length < PIN_MIN_LENGTH || pin.length > PIN_MAX_LENGTH) {
    throw new PinFormatError(
      `a PIN is ${PIN_MIN_LENGTH}-${PIN_MAX_LENGTH} digits; this one is ${pin.length}`,
    );
  }
  if (!PIN_PATTERN.test(pin)) throw new PinFormatError("a PIN is digits only");
}

/** Argon2id with a fresh 16-byte salt, PHC-encoded (spec:1324, 2132; ADR 0060). */
export async function hashPin(pin: string): Promise<string> {
  assertPin(pin);
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  return argon2id({
    password: pin,
    salt,
    parallelism: PARALLELISM,
    iterations: ITERATIONS,
    memorySize: MEMORY_SIZE_KIB,
    hashLength: HASH_LENGTH,
    outputType: "encoded",
  });
}

/**
 * Verifies at the till (6B) against the down-synced mirror. Returns false — never throws — on a hash
 * this build cannot parse, so a corrupted mirror row is a refused login and not a crashed till.
 */
export async function verifyPin(pin: string, phc: string): Promise<boolean> {
  if (pin.length < PIN_MIN_LENGTH || pin.length > PIN_MAX_LENGTH || !PIN_PATTERN.test(pin))
    return false;
  if (!phc.startsWith("$argon2id$")) return false;
  try {
    return await argon2Verify({ password: pin, hash: phc });
  } catch {
    return false;
  }
}
