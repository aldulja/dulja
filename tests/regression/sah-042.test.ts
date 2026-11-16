import { thinRegression, sliceRegression } from "../support/regression";
import { seedAccount, seedParty, seedTenantV2, uuidv7 } from "@dulja/db/test";

thinRegression(
  "SAH-042",
  "Ownership and paid-record checks fail open when the user row is missing",
  "packages/db/test/ledger.test.ts",
  async ({ rw, a, withTenant, expect }) => {
    const GHOST = "00000000-0000-7000-8000-0000000042ff";
    // The predicate answers about a principal that does not exist: FALSE, never NULL, never true. A missing user
    // row closes the door instead of opening it (plan0A:985–1004 — actor_has never fails open).
    const [ghost] = await withTenant(
      rw,
      { tenantId: a.tenant, actorId: GHOST, requestId: "sah-042" },
      (tx) =>
        tx<{ company: boolean; branch: boolean; unknown_code: boolean }[]>`
        select app.actor_has('admin.user.manage', ${a.company})            as company,
               app.actor_has('admin.user.manage', ${a.company}, ${a.hq})   as branch,
               app.actor_has('admin.never.granted', ${a.company})          as unknown_code`,
    );
    expect(ghost).toEqual({ company: false, branch: false, unknown_code: false });
    // false, never null: `expect(x).toBe(false)` would pass on null under a loose check, so the whole row is
    // compared. Company-wide, branch-scoped and unknown-code all close, which is what "never fails open" means.
  },
);

// ─── 2B ──────────────────────────────────────────────────────────────────────────────────────────────────
// contracts §3.7.3: 0B created this file; a later slice appends and never edits the block above.
sliceRegression(
  "SAH-042",
  "Ownership and paid-record checks fail open when the user row is missing",
  "2B",
  "app.principal_has never fails open: an unknown, unassigned, expired or wrong-branch principal is false",
  async ({ db, rw, withTenant, expect }) => {
    const s = await seedTenantV2(db, "SAH042-2B");
    const ghost = await uuidv7(db.admin); // a principal that does not exist at all
    const expired = await uuidv7(db.admin);
    const roleId = await uuidv7(db.admin);
    await db.migrator.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${s.tenant}, true), set_config('app.actor_id', ${s.system}, true)`;
      await tx`insert into app.principal (id, kind, auth_subject, display_name)
               values (${expired}, 'human', ${`expired:${s.tenant}`}, 'expired')`;
      await tx`insert into app.membership (tenant_id, principal_id) values (${s.tenant}, ${expired})`;
      await tx`insert into app.role (id, tenant_id, code, name_en) values (${roleId}, ${s.tenant}, 'sah042', 'Lapsed')`;
      await tx`insert into app.role_permission (tenant_id, role_id, permission_code)
               values (${s.tenant}, ${roleId}, 'accounting.journal.post')`;
      await tx`insert into app.role_assignment (tenant_id, principal_id, role_id, company_id, expires_at)
               values (${s.tenant}, ${expired}, ${roleId}, ${s.company}, now() - interval '1 day')`;
    });
    const ctx = { tenantId: s.tenant, actorId: s.human, requestId: "sah042" };
    const [r] = await withTenant(
      rw,
      ctx,
      (tx) => tx<
        { ghost: boolean; expired_row: boolean; unassigned: boolean; null_branch_ghost: boolean }[]
      >`select app.principal_has(${ghost}::uuid, 'accounting.journal.post', ${s.company}, ${s.hq}) as ghost,
               app.principal_has(${expired}::uuid, 'accounting.journal.post', ${s.company}, ${s.hq}) as expired_row,
               app.principal_has(${s.human}::uuid, 'accounting.journal.post', ${s.company}, ${s.hq}) as unassigned,
               app.principal_has(${ghost}::uuid, 'accounting.journal.post', ${s.company}) as null_branch_ghost`,
    );
    // The legacy check was DEFEATED by supplying an invalid user: NULL <> 0 is unknown, so the guard was
    // skipped. Every answer here is a hard false, and omitting the branch buys nothing.
    expect(r).toEqual({
      ghost: false,
      expired_row: false,
      unassigned: false,
      null_branch_ghost: false,
    });
  },
);

// ─── 4A ──────────────────────────────────────────────────────────────────────────────────────────────────
// Credit control never fails open. SAH-042's shape is exactly "an absent row makes a check pass", and 4A's
// migration 0045 adds the one control in the system whose inputs (a party, a policy direction, a control
// account) can each be absent. contracts §3.7.3: appended, the blocks above are not edited.
sliceRegression(
  "SAH-042",
  "Credit control never fails open",
  "4A",
  "an unresolvable party or policy makes the trigger RETURN through a named guard, never through NULL logic",
  async ({ db, expect }) => {
    // The legacy defect was `select … into :X; if (X <> 0) then exception` — a missing row left X NULL,
    // NULL <> 0 was unknown, and the check was skipped. Here the equivalent branch is explicit: a document
    // with no party_id, or a party row that is not a customer, is not a credit sale AT ALL, and the function
    // says so in a named guard rather than falling through three-valued logic.
    const [fn] = await db.admin<{ src: string }[]>`
      select prosrc as src from pg_proc
       where proname = 'assert_credit_available' and pronamespace = 'app'::regnamespace`;
    // Every conditional in the body compares against a literal or uses `is distinct from`; there is no bare
    // `<>` against a value that can be NULL, which is the exact defect shape. Since the code review of
    // 2026-09-29 the direction question is app.policy_extends_credit's, asked `is distinct from true`, and
    // that predicate compares the direction `is not distinct from 'outbound'` — NULL-safe on both sides.
    expect(fn!.src).toMatch(/app\.policy_extends_credit\([^;]*\)\s+is distinct from true then/);
    const [predicate] = await db.admin<{ src: string }[]>`
      select prosrc as src from pg_proc
       where proname = 'policy_extends_credit' and pronamespace = 'app'::regnamespace`;
    expect(predicate!.src).toMatch(/is not distinct from 'outbound'/);
    // The party guards are named, and since the Phase 4 review (A7) they ask whether the party HAS a limit
    // or a hold, never what kind it is: a kind guard let a limit on a dealer or a vendor silently do nothing.
    expect(fn!.src).toMatch(/if v_party\.id is null then return new; end if;/);
    expect(fn!.src).toMatch(
      /if v_party\.credit_limit is null and not v_party\.credit_hold then return new; end if;/,
    );
    expect(fn!.src).not.toMatch(/v_party\.kind/);
    // The control reads no session flag: an override is a document_event row, never a setting (SAH-027).
    expect(fn!.src).not.toMatch(/current_setting|set_config/i);
  },
);

sliceRegression(
  "SAH-042",
  "Credit control never fails open",
  "4A",
  "a NULL credit_limit is a documented 'no limit', and a NULL balance cannot arise (SAH-011)",
  async ({ db, expect }) => {
    // 0127 (ADR 0095) moved the sum into the company-wide lookup party_open_balance calls; the shape is read there.
    const [fn] = await db.admin<{ src: string }[]>`
      select prosrc as src from pg_proc
       where proname = 'party_company_open_balance' and pronamespace = 'app'::regnamespace`;
    // coalesce at the accumulation boundary — SAH-011's fix, applied to the one aggregate this slice adds.
    expect(fn!.src).toMatch(/coalesce\(sum\(l\.base_debit - l\.base_credit\), 0\)/);
  },
);

sliceRegression(
  "SAH-042",
  "Credit control never fails open",
  "4A",
  "a party with a limit and NO control account RAISES — the behaviour, not the source text",
  async ({ db, rw, withTenant, expect }) => {
    // The two cases above read `prosrc`, which proves the shape of the code and not the behaviour of the
    // database. This one calls the function, because a source-text assertion would have passed against the
    // fail-open version this block exists to forbid.
    const seed = await seedTenantV2(db, "sah-042-4a");
    await seedAccount(db, seed, { code: "1200", nameEn: "Trade receivables", type: "asset" });
    const party = await seedParty(db, seed, { kind: "customer", code: "CUST-NOCTRL" });
    // 0127 (ADR 0095): the control-account pin answers only to a live role in the company.
    await grantCodes(db, seed, {});
    const ctx = { tenantId: seed.tenant, actorId: seed.human, requestId: "sah042-4a" };
    await withTenant(
      rw,
      ctx,
      (tx) =>
        tx`update app.party set credit_limit = ${"500.0000"}, receivable_account_id = null where id = ${party}`,
    );
    await expect(
      withTenant(
        rw,
        ctx,
        (tx) => tx`select app.party_open_balance(${party}, ${"2026-01-31"}::date)`,
      ),
    ).rejects.toThrow(/ERR_POLICY_REQUIRES_MISSING/);
    // Cleared limit, same null account: no credit question, no raise, and a zero that means zero.
    await withTenant(
      rw,
      ctx,
      (tx) => tx`update app.party set credit_limit = null where id = ${party}`,
    );
    const [open] = await withTenant(
      rw,
      ctx,
      (tx) =>
        tx<
          { v: string }[]
        >`select app.party_open_balance(${party}, ${"2026-01-31"}::date)::text as v`,
    );
    expect(open!.v).toBe("0.0000");
  },
);

// 8B Task 14 — an absent role row is a refusal, never a default-through. Its own tenant: payrollFixture is not
// idempotent.
import { calculatePayrollRun, transitionDocument } from "@dulja/db";
import { grantCodes } from "@dulja/db/test";
import { payrollFixture, secondApprover } from "../invariants/support/payroll";

sliceRegression(
  "SAH-042",
  "Ownership and paid-record checks fail open when the user row is missing",
  "8B",
  "a principal whose role carries NO code cannot approve a PAYROLL run, through the service or raw SQL",
  async ({ db, withTenant, expect }) => {
    const s = await seedTenantV2(db, "SAH-042");
    await payrollFixture(db, s);
    await grantCodes(db, s, { codes: ["hr.payroll.prepare"] });
    // A member of the tenant whose one role carries no permission row: the absent row must read as "no", never
    // as "allowed". (A company-wide empty role keeps the run VISIBLE, so the refusal is R2's and not RLS's 404.)
    const stranger = await secondApprover(db, s, []);
    const asHuman = { tenantId: s.tenant, actorId: s.human, requestId: "sah-042-8b" };
    const asStranger = { tenantId: s.tenant, actorId: stranger, requestId: "sah-042-8b" };
    const r = await withTenant(db.rw, asHuman, (tx) =>
      calculatePayrollRun(tx, asHuman, {
        companyId: s.company,
        kind: "regular",
        periodStart: "2026-07-01",
        periodEnd: "2026-07-31",
        payDate: "2026-08-05",
        effectiveDate: "2026-07-31",
        branchId: s.hq,
      }),
    );
    await withTenant(db.rw, asHuman, (tx) =>
      transitionDocument(tx, asHuman, { documentId: r.documentId, to: "submitted" }),
    );
    await expect(
      withTenant(db.rw, asStranger, (tx) =>
        transitionDocument(tx, asStranger, { documentId: r.documentId, to: "approved" }),
      ),
    ).rejects.toThrow(/^ERR_RBAC_FORBIDDEN: principal .* does not hold hr\.payroll\.approve/);
    await expect(
      withTenant(
        db.rw,
        asStranger,
        (tx) => tx`update app.document set status = 'approved' where id = ${r.documentId}`,
      ),
    ).rejects.toThrow(/^ERR_RBAC_FORBIDDEN/);
    const [row] = await db.admin<{ status: string }[]>`
      select status::text as status from app.document where id = ${r.documentId}`;
    expect(row!.status).toBe("submitted");
  },
);

// ─── full review 2026-11-15: DBS-04 (migration 0127, ADR 0095) ────────────────────────────────────────────
// Appended. Credit control failed open by BRANCH: the exposure was summed under the issuer's RLS, so a clerk
// restricted to one branch did not see the party's sales at another and issued past the limit with no
// override. The exposure is now read through company-bound definer lookups returning one base total each.
// The full case is `packages/db/test/ar-ap/credit-branch-isolation.test.ts`.
import { issueDocument } from "@dulja/db";
import { draftTypedDocument, seedBranch, seedDocumentType } from "@dulja/db/test";
import { secondPrincipal } from "../invariants/support/post-inventory";

sliceRegression(
  "SAH-042",
  "Credit control never fails open",
  "full review 2026-11-15 (0127)",
  "a clerk restricted to one branch is measured against the exposure of every branch",
  async ({ db, withTenant, expect }) => {
    const s = await seedTenantV2(db, "SAH042-0127");
    await seedAccount(db, s, { code: "1200", nameEn: "Trade receivables", type: "asset" });
    await seedAccount(db, s, { code: "4000", nameEn: "Sales", type: "income" });
    await grantCodes(db, s, { codes: ["accounting.sales.post"] });
    const typeId = await seedDocumentType(db, s, {
      code: "SAH042_0127",
      policy: {
        version: 1,
        documentType: "SAH042_0127",
        direction: "outbound",
        requires: ["party"],
        lines: [
          {
            for: "each_line",
            side: "debit",
            account: { from: "party.receivable_account" },
            amount: "line.total_incl_tax",
            when: { "line.kind": "item" },
          },
          {
            for: "each_line",
            side: "credit",
            account: { code: "4000" },
            amount: "line.amount",
            when: { "line.kind": "item" },
          },
        ],
        inventory: { effect: "none" },
        tax: { applies: false },
        numbering: { series: "S42", assignAt: "issue" },
        reversal: { allowed: false, producesType: null },
        approval: { required: false, approve: null, post: "accounting.sales.post" },
        fxRoundingAccount: { from: "company.fx_rounding_account_id" },
        dimensions: { required: [] },
      },
    });
    const brb = await seedBranch(db, s, { code: "BRB" });
    const partyId = await seedParty(db, s, { kind: "customer", code: "SAH042-0127" });
    const clerk = await secondPrincipal(db, s, "sah042-brb-clerk");
    await grantCodes(db, s, {
      codes: ["accounting.sales.post"],
      principalId: clerk,
      roleCode: "sah042-brb",
      branchIds: [brb],
    });
    const as = (actor: string) => ({
      tenantId: s.tenant,
      actorId: actor,
      requestId: "sah-042-0127",
    });
    await withTenant(
      db.rw,
      as(s.human),
      (tx) => tx`update app.party set credit_limit = ${"1000.0000"} where id = ${partyId}`,
    );
    const draftAt = async (branchId: string) => {
      const { documentId } = await draftTypedDocument(db, s, {
        documentTypeId: typeId,
        series: "S42",
        partyId,
        branchId,
        lines: [
          {
            kind: "item",
            description: "w",
            amount: "900.0000",
            unitPrice: "900.0000",
            quantity: "1.000000",
          },
        ],
      });
      await withTenant(
        db.rw,
        as(s.human),
        (tx) =>
          tx`update app.document_line set total_incl_tax = ${"900.0000"} where document_id = ${documentId}`,
      );
      return documentId;
    };
    const hq = await draftAt(s.hq);
    await withTenant(db.rw, as(s.human), (tx) =>
      issueDocument(tx, as(s.human), { documentId: hq }),
    );
    const atBrb = await draftAt(brb);
    await expect(
      withTenant(db.rw, as(clerk), (tx) => issueDocument(tx, as(clerk), { documentId: atBrb })),
    ).rejects.toThrow(/ERR_CREDIT_LIMIT_EXCEEDED/);
  },
);
