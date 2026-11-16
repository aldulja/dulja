import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  parsePolicy,
  PolicyEvaluationError,
  validateDocumentTypeSeed,
  validatePolicy,
} from "../../src/posting";

const JOURNAL_ENVELOPE = JSON.parse(
  readFileSync(fileURLToPath(new URL("./journal-envelope.fixture.json", import.meta.url)), "utf8"),
) as { policy: unknown };

const CATALOGUE = [
  "accounting.account.manage",
  "accounting.ledger.read",
  "accounting.period.close",
  "accounting.period.reopen",
  "accounting.journal.create",
  "accounting.journal.post",
];

describe("validatePolicy — contracts §4.4.1 at the JOURNAL subset", () => {
  it("accepts the JOURNAL policy of contracts §4.3.7", () => {
    expect(validatePolicy(JOURNAL_ENVELOPE.policy, CATALOGUE)).toEqual({ ok: true, errors: [] });
  });

  it("accepts the whole §4.3.7 envelope against document-type-seed.schema.json", () => {
    expect(validateDocumentTypeSeed(JOURNAL_ENVELOPE)).toEqual({ ok: true, errors: [] });
  });

  it("rejects an unknown member — the schema is additionalProperties: false (spec:2008)", () => {
    const bad = { ...(JOURNAL_ENVELOPE.policy as object), nameEn: "Journal Voucher" };
    const result = validatePolicy(bad, CATALOGUE);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatchObject({
      path: "",
      message: expect.stringContaining("nameEn"),
    });
  });

  it("rejects an approval code the catalogue does not contain (F-21)", () => {
    const policy = JSON.parse(JSON.stringify(JOURNAL_ENVELOPE.policy)) as {
      approval: { post: string };
    };
    policy.approval.post = "accounting.purchase.post";
    const result = validatePolicy(policy, CATALOGUE);
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([
      {
        path: "/approval/post",
        message: "accounting.purchase.post is not in the permission catalogue",
      },
    ]);
  });

  it("rejects a version other than 1 — a schema change is a new const and a new $id", () => {
    const policy = { ...(JOURNAL_ENVELOPE.policy as object), version: 2 };
    expect(validatePolicy(policy, CATALOGUE).ok).toBe(false);
  });

  it("parsePolicy returns the policy and throws ERR_POLICY_INVALID on anything else", () => {
    expect(parsePolicy(JOURNAL_ENVELOPE.policy).documentType).toBe("JOURNAL");
    // The Plan 0A fixture policy — a stub with no requires/inventory/tax/numbering/reversal/approval blocks.
    const stub = { version: 1, documentType: "JOURNAL", direction: "none", lines: [] };
    let caught: unknown;
    try {
      parsePolicy(stub);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PolicyEvaluationError);
    expect((caught as PolicyEvaluationError).code).toBe("ERR_POLICY_INVALID");
    expect((caught as PolicyEvaluationError).detail).toContain("numbering");
  });

  it("rejects an envelope whose file code and policy.documentType disagree (§4.3.7)", () => {
    const bad = { ...JOURNAL_ENVELOPE, code: "JOURNAL_2" };
    const result = validateDocumentTypeSeed(bad);
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([
      { path: "/code", message: "code JOURNAL_2 does not equal policy.documentType JOURNAL" },
    ]);
  });
});

const SALES_INVOICE = JSON.parse(
  readFileSync(fileURLToPath(new URL("./sales-invoice.fixture.json", import.meta.url)), "utf8"),
) as Record<string, unknown>;
const JOURNAL_POLICY_FIXTURE = JOURNAL_ENVELOPE.policy;

describe("the widened schema — contracts §4.4.1 in full, ADR 0026", () => {
  // packages/domain may not import @dulja/contracts (§3.1), so the catalogue is a literal here, exactly as
  // 1A's own cases build it. These six codes are the ones the fixtures below name — the three `hr.payroll.*`
  // entries are what the payroll fixture further down resolves its component and scheme accounts under.
  const catalogue = [
    "accounting.journal.create",
    "accounting.journal.post",
    "accounting.sales.post",
    "hr.payroll.approve",
    "hr.payroll.post",
    "hr.payroll.prepare",
  ] as const;

  it("the spec:2008-2028 SALES_INVOICE example validates (spec:2006 — 'the shape it must at minimum cover')", () => {
    expect(validatePolicy(SALES_INVOICE, catalogue)).toEqual({ ok: true, errors: [] });
  });

  it("every policy valid under 1A's subset is still valid — the widening adds labels and optional members only", () => {
    expect(validatePolicy(JOURNAL_POLICY_FIXTURE, catalogue)).toEqual({ ok: true, errors: [] });
  });

  it("the $id and the version const are unchanged, so 1A's committed files need no migration", () => {
    const schema = JSON.parse(
      readFileSync(
        fileURLToPath(new URL("../../posting-policy.schema.json", import.meta.url)),
        "utf8",
      ),
    ) as { $id: string; properties: { version: unknown }; additionalProperties: boolean };
    expect(schema.$id).toBe("urn:dulja:posting-policy:1");
    expect(schema.properties.version).toEqual({ const: 1 });
    expect(schema.additionalProperties).toBe(false);
  });

  it("an inventory effect other than 'none' requires a warehouse and a costing rule", () => {
    const bad = { ...SALES_INVOICE, inventory: { effect: "issue" } };
    const report = validatePolicy(bad, catalogue);
    expect(report.ok).toBe(false);
    expect(report.errors.map((e) => e.message).join(" ")).toMatch(/warehouse/);
  });

  it("approval.required = true forces a non-null approve code", () => {
    const bad = {
      ...SALES_INVOICE,
      approval: { required: true, approve: null, post: "accounting.sales.post" },
    };
    expect(validatePolicy(bad, catalogue).ok).toBe(false);
  });

  it("an approval code absent from the catalogue is refused at seed time (F-21)", () => {
    const bad = {
      ...SALES_INVOICE,
      approval: { required: false, approve: null, post: "accounting.purchase.post" },
    };
    expect(validatePolicy(bad, catalogue)).toEqual({
      ok: false,
      errors: [
        {
          path: "/approval/post",
          message: "accounting.purchase.post is not in the permission catalogue",
        },
      ],
    });
  });

  it("an unknown property is still refused — additionalProperties: false did not loosen", () => {
    expect(validatePolicy({ ...SALES_INVOICE, nameEn: "Sales invoice" }, catalogue).ok).toBe(false);
  });

  it("a policy line may declare its dimension sources and the required dimension types", () => {
    const tagged = {
      ...SALES_INVOICE,
      lines: [
        {
          for: "each_line",
          side: "debit",
          account: { code: "1200" },
          amount: "line.amount",
          when: { "line.kind": "item", "item.kind": "product" },
          dimensions: { from: ["line.dimensions", "document.branch"] },
        },
      ],
      dimensions: { required: ["BRANCH"] },
    };
    expect(validatePolicy(tagged, catalogue)).toEqual({ ok: true, errors: [] });
  });

  it("a payroll policy resolves component and scheme accounts and filters on the employer share (spec:2101)", () => {
    const payroll = {
      version: 1,
      documentType: "PAYROLL",
      direction: "none",
      requires: [],
      lines: [
        {
          for: "each_line",
          side: "debit",
          account: { from: "line.component.expense_account" },
          amount: "line.amount",
          when: { "line.kind": "payroll", "line.component.kind": "earning" },
        },
        {
          for: "each_line",
          side: "debit",
          account: { from: "line.scheme.expense_account" },
          amount: "line.amount",
          when: { "line.kind": "payroll", "line.share": "employer" },
        },
        {
          for: "each_line",
          side: "credit",
          account: { from: "line.scheme.payable_account" },
          amount: "line.amount",
          when: { "line.kind": "payroll" },
        },
      ],
      inventory: { effect: "none" },
      tax: { applies: false },
      numbering: { series: "PAY", assignAt: "issue" },
      reversal: { allowed: true, producesType: "PAYROLL" },
      approval: {
        required: true,
        approve: "hr.payroll.approve",
        post: "hr.payroll.post",
        create: "hr.payroll.prepare",
      },
      fxRoundingAccount: { from: "company.fx_rounding_account_id" },
      dimensions: { required: ["BRANCH", "EMPLOYEE"] },
    };
    expect(validatePolicy(payroll, catalogue)).toEqual({ ok: true, errors: [] });
  });
});
