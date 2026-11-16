/**
 * The tenant's content, named in one place because two sides read it: `boot.ts` seeds it into the
 * local database, and `rtl-parity.spec.ts` measures the cells it draws. Kept free of any heavy
 * import — a spec that pulled `boot.ts` in would drag Testcontainers and the whole API into every
 * Playwright worker, including the staging run that starts nothing locally.
 */

export interface Person {
  displayName: string;
  email: string | null;
}

/**
 * Chosen for what they put in a cell rather than for plausibility: one plain Latin name, one Arabic
 * name, and one that mixes an Arabic word with a Latin run and Western digits — which is the case
 * `<bdi>` exists for and the case a direction bug scrambles (spec:2253, "numerals … and column
 * order"). `seedTenant`'s own two principals (the system one and the human this session signs in
 * as) are rows too, and neither carries an e-mail, so the nullable-e-mail cell is on screen without
 * anyone arranging it.
 */
export const PEOPLE: readonly Person[] = [
  { displayName: "Nadia Rahman", email: "nadia@dulja.test" },
  { displayName: "هدى الشمري", email: "huda@dulja.test" },
  { displayName: "مبيعات ABC-123", email: "sales@dulja.test" },
];

/** The Latin-only row, used wherever a spec just needs to know the list has arrived. */
export const LATIN_NAME = "Nadia Rahman";
/** The row whose one cell carries an Arabic word, a Latin run and Western digits at once. */
export const MIXED_NAME = "مبيعات ABC-123";
export const MIXED_EMAIL = "sales@dulja.test";

/**
 * Who the suite signs in as. Overridable because the staging run (OD-20/OD-21) signs in to real
 * Supabase with a real account: `PLAYWRIGHT_BASE_URL` picks the target, these two pick the
 * operator, and the spec file itself does not change. The local stub checks no password — the thing
 * under test is the screen, not the identity provider.
 */
export const E2E_EMAIL = process.env["PLAYWRIGHT_EMAIL"] ?? "owner@example.test";
export const E2E_PASSWORD = process.env["PLAYWRIGHT_PASSWORD"] ?? "e2e-password";

/** 8A T13: the employee whose HR record `hr.spec.ts` edits — never the signed-in operator (R4, spec:2175). */
export const E2E_HR_EMPLOYEE = "E2E-HR";

/**
 * ADR 0096's set-password step, against the local auth stub only. The invitee has never signed in
 * and has no factor; the throttled address is the one the stub rate-limits; the recovery code is
 * the one the stub "e-mails", and the TOTP code is the one it accepts for the owner's factor.
 */
export const E2E_INVITEE_EMAIL = "invitee@example.test";
export const E2E_THROTTLED_EMAIL = "throttled@example.test";
export const E2E_RECOVERY_CODE = "482913";
export const E2E_TOTP_CODE = "319284";
