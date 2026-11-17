import { describe, it } from "vitest";

/**
 * ⚠️ CONDITIONAL — created by 1A per contracts §3.7.3 and left skipped until OD-27 answers Part VII #6.
 *
 * spec:427: "`IncCodeNumber` is an external UDF not in the corpus; it may zero-pad and avoid this. Confirm
 * before rating." Until the owner supplies the legacy DDL and that UDF's body, the defect is a hypothesis,
 * not a fact, and the new system's behaviour is not in question either way: Dulja never derives an account
 * code. `POST /v1/companies/{companyId}/accounts` takes the code from the caller and
 * `unique (company_id, code)` refuses a duplicate, which is asserted in
 * apps/api/test/routes/accounting/accounts.test.ts, the test named
 * "refuses a duplicate code in the company with ERR_CONFLICT_UNIQUE".
 *
 * WHEN OD-27 LANDS: if the owner confirms the defect, replace the `it.skip` below with an `it` that seeds a
 * legacy-shaped chart through the API and asserts that codes '1', '9' and '10' coexist and that two
 * concurrent creates of the same code produce one 201 and one 409 ERR_CONFLICT_UNIQUE. If the owner reports
 * that `IncCodeNumber` zero-pads and the defect never existed, delete this file and remove its row from the
 * regression table in plan 1A's Self-Review.
 */
describe("LEGACY-024 Account codes allocated with max() on a string, without locking — 1A", () => {
  it.skip("⚠️ pending OD-27 (Part VII #6, spec:427): the legacy DDL and IncCodeNumber's body are not in the corpus", () => {
    // Deliberately empty: this test is a placeholder for an owner decision, not for missing work.
  });
});
