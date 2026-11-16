export interface RoleSeed {
  readonly code: string;
  readonly nameEn: string;
  readonly nameAr: string;
  readonly description: string;
  readonly permissions: readonly string[];
}

export const ADMIN_EXCLUDED_CODES: readonly string[] = ["pos.ticket.sell"];
export const ADMIN_EXCLUDED_PREFIXES: readonly string[] = ["pos.sync."];

export function adminPermissions(catalogue: readonly string[]): readonly string[] {
  return catalogue.filter(
    (code) =>
      !ADMIN_EXCLUDED_CODES.includes(code) &&
      !ADMIN_EXCLUDED_PREFIXES.some((prefix) => code.startsWith(prefix)),
  );
}

export const ROLES: readonly RoleSeed[] = [
  {
    code: "admin",
    nameEn: "Administrator",
    nameAr: "مدير النظام",
    description:
      "Tenant owner with every current catalogue permission except till selling and terminal synchronization.",
    permissions: [],
  },
  {
    code: "accountant",
    nameEn: "Accountant",
    nameAr: "محاسب",
    description:
      "Head-office bookkeeper responsible for journals, posting, reconciliation, tax, and period close.",
    permissions: [
      "accounting.tax.manage",
      "accounting.tax.file",
      // 1A (spec:2157 — chart of accounts, journals and their posting, period close; NOT period reopen)
      "accounting.account.manage",
      "accounting.ledger.read",
      "accounting.period.close",
      "accounting.journal.create",
      "accounting.journal.post",
      // 2B (spec:2157 — corrections are accountant work; D13 makes a correction a reversal). The code gates
      // the route only: the reversing document is still posted under approval.post of the reversal type
      // through the status trigger, so a role that can reverse but not post gets ERR_RBAC_FORBIDDEN.
      "accounting.document.reverse",
      // 1B (spec:2157 — the head-office bookkeeping surface includes the reports).
      "accounting.report.read",
      // 3A (spec:2157 — the bookkeeper reads the catalogue and stock; both codes are non-mutating).
      "inventory.item.read",
      "inventory.stock.read",
      // 3B (§3.6.4 — the valuation and cost-layer reads; mutating: false, which is what lets the auditor
      // hold it under R7, spec:2178).
      "inventory.cost.read",
      // 3C (spec:2159 — sales and purchase documents and their posting). The accountant deliberately gets
      // neither inventory.receipt code: spec:2159 gives receipt posting to the warehouse instead.
      "accounting.purchase.create",
      "accounting.purchase.post",
      // 3D (spec:2159 — approve stock counts and expiry/damage write-offs). ONE code, and deliberately
      // NOT inventory.adjustment.create: the approver never drafts, which is what keeps R1 non-vacuous on
      // STOCK_COUNT (test 31).
      "inventory.adjustment.approve",
      // 4A (spec:2157 — sales and purchase documents and their posting, receipts (create and post — money
      // in), payment approval and posting, every approval and exception authority). Six of the seven 4A
      // codes. accounting.payment.create is DELIBERATELY absent: payments are drafted by user, and holding
      // it beside accounting.payment.approve is the R6 payment pair declared at the foot of this file, which
      // goes live in the role-seed lint with this slice (both codes are now in the catalogue). That lint
      // stops parsing the role list at the first occurrence of the name of the pair constant, so no
      // comment above the constant itself may spell that name out, and it reads every quote mark inside
      // a permissions array as a string delimiter, so no comment here may contain one.
      "accounting.sales.post",
      "accounting.receipt.create",
      "accounting.receipt.post",
      "accounting.payment.approve",
      "accounting.payment.post",
      "accounting.credit_limit.override",
      // 4B (spec:2157 — release of the net-pay bank batch, bank reconciliation, tax returns, period close).
      // The auditor must NOT hold it: the code is mutating and R7 forbids the auditor any mutating code
      // (spec:2178, enforced by scripts/lint/rules/role-seed.ts).
      "accounting.bank.reconcile",
      // 8A (spec:2160 — the accountant verifies statutory tables as the HR checker). R6 forbids one seeded role
      // holding both halves of the load and verify pair, so the load half goes to hr_payroll and this is the other.
      "hr.statutory_table.verify",
      // 8B (spec:2157 — approve and post payroll as the HR checker). R6 forbids one seeded role holding both
      // prepare and approve, so prepare goes to hr_payroll and these are the other half.
      "hr.payroll.read",
      "hr.payroll.approve",
      "hr.payroll.post",
    ],
  },
  {
    code: "user",
    nameEn: "Clerk",
    nameAr: "مستخدم",
    description:
      "General back-office clerk who drafts operational documents without approval or posting authority.",
    permissions: [
      // 1A (spec:2158 — drafts documents; may not post). Reading the chart of accounts needs membership only.
      "accounting.journal.create",
      // 2A (spec:2159 — maintains customers and vendors; R7 spec:2178 names the pair).
      "accounting.party.manage",
      // 3A (spec:2158 — the clerk reads accounts, items and stock; never writes the catalogue).
      "inventory.item.read",
      "inventory.stock.read",
      // 3C (spec:2159 — draft sales and purchase orders and documents, the create codes). Drafting only:
      // the clerk never holds accounting.purchase.post.
      "accounting.purchase.create",
      // 3D (spec:2159, the sales half of the same sentence). Drafting only: posting a delivery order is
      // inventory.transfer.post, which this role does not hold.
      "accounting.sales.create",
      // 4A (spec:2158 — draft receipts and payments, the create codes; may not post, approve or override
      // credit limits). Drafting only: the clerk holds no 4A post, approve or override code.
      "accounting.receipt.create",
      "accounting.payment.create",
      // 6C — staff directory, attendance and branch PIN authority (spec:2159–2162).
      "hr.employee.read",
    ],
  },
  {
    code: "warehouse",
    nameEn: "Warehouse",
    nameAr: "أمين المستودع",
    description:
      "Store staff handling receipts, transfers, stock counts, and controlled write-off drafts.",
    permissions: [
      // 3A — the first codes this role holds. spec:2159 denies this role prices and the item master, so the
      // two reads only: the catalogue write and the negative-stock override stay with computed admin.
      "inventory.item.read",
      "inventory.stock.read",
      // NOT inventory.cost.read (code review 2, S1b): spec:2159 lists costs under May not for this role,
      // and spec:2163 gives the auditor stock and costs as a READ, so costs in that column is sight of
      // them. The valuation and cost-layer reads are the accountant and auditor grant alone.
      // 3C (spec:2159 — receive against purchase documents, post receipts and transfers, quantities only).
      // branch_manager gets neither code: receiving transfers is 3D inventory.transfer authority.
      "inventory.receipt.create",
      "inventory.receipt.post",
      // 3D (spec:2160 — transfer to branches, draft stock counts and expired/damaged write-offs, and post
      // receipts and transfers, quantities only). Never inventory.adjustment.approve: the drafter of a
      // count or a write-off is not its approver (R1, test 31).
      "inventory.transfer.create",
      "inventory.transfer.post",
      "inventory.count.create",
      "inventory.adjustment.create",
    ],
  },
  {
    code: "branch_manager",
    nameEn: "Branch manager",
    nameAr: "مدير الفرع",
    description:
      "Branch-scoped shop manager with second-principal overrides and branch operations authority.",
    permissions: [
      "pos.shift.close_any",
      "pos.report.read",
      "pos.price.check",
      "pos.shift.own",
      "pos.attendance.clock",
      "pos.ticket.sell",
      "pos.ticket.discount",
      "pos.ticket.return",
      "pos.customer.create",
      "pos.ticket.void",
      "pos.ticket.return_blind",
      "pos.ticket.override",
      "pos.needs_attention.resolve",
      // 3A — reads the catalogue, never writes it: spec:2160 gives the catalogue to head office.
      "inventory.item.read",
      "inventory.stock.read",
      // NOT inventory.cost.read (code review 2, S1b): spec:2160 lists costs under May not for this role,
      // beside prices and anything in another branch. spec:1022 (stock and margin visible per branch)
      // names no role, so it grants this one nothing.
      // 3D (spec:2160 — receiving transfers, drafting counts and write-offs): the same four the
      // warehouse role holds, and like it never inventory.adjustment.approve.
      "inventory.transfer.create",
      "inventory.transfer.post",
      "inventory.count.create",
      "inventory.adjustment.create",
      // 6C — staff directory, attendance and branch PIN authority (spec:2159–2162).
      "hr.employee.read",
      "hr.attendance.record",
      "pos.cashier.manage_pin",
    ],
  },
  {
    code: "cashier",
    nameEn: "Cashier",
    nameAr: "أمين الصندوق",
    description:
      "Branch till operator who sells and manages an owned shift within assigned limits.",
    permissions: [
      "pos.price.check",
      "pos.shift.own",
      "pos.attendance.clock",
      "pos.ticket.sell",
      "pos.ticket.discount",
      "pos.ticket.return",
      "pos.customer.create",
    ],
  },
  {
    code: "hr_payroll",
    nameEn: "HR and payroll",
    nameAr: "الموارد البشرية والرواتب",
    description:
      "HR officer managing employee and payroll preparation without self-approval authority.",
    permissions: [
      "hr.employee.read",
      "hr.employee.manage",
      "hr.attendance.record",
      // 8A (spec:2162 — the employee master including sensitive data, compensation and pay components, and
      // loading statutory tables, which a different principal verifies). The auditor gets none of the six:
      // spec:2163 excludes identity numbers, bank details and compensation rows by name.
      "hr.employee.read_sensitive",
      "hr.compensation.read",
      "hr.compensation.manage",
      "hr.pay_component.manage",
      "hr.statutory_table.manage",
      // 8B (spec:2162 — payroll prepare and submit; may not approve or post payroll).
      "hr.payroll.read",
      "hr.payroll.prepare",
      // 8C (spec:2082, spec:2162 — releases the payroll payment batch and creates staff advances). Approval and
      // posting of both stay accounting.payment.approve / .post, which this role does not hold (R1).
      "hr.payroll.pay",
      "hr.advance.create",
      // 8D (spec:2083, spec:2162 — the officer produces the payslips from a posted run). Generating a filing changes
      // no posted figure; it reads them. The auditor may hold no mutating code (R7), so it is the officer alone.
      "hr.filing.generate",
      // 8D Task 8 (⚠️ OD-13 answered build; spec:2085, 2162 — HR enters entitlements and records leave, and a
      // principal other than the employee decides it). The officer holds both: R4 refuses their OWN leave per row
      // (the 0096 trigger), so a one-person HR office still works and still cannot approve itself. INCOMPATIBLE_PAIRS
      // is not extended — spec:2177's list is closed at four pairs.
      "hr.leave.record",
      "hr.leave.approve",
    ],
  },
  {
    code: "auditor",
    nameEn: "Auditor",
    nameAr: "مدقق",
    description:
      "Read-only external or statutory auditor with access to audit evidence and reports.",
    permissions: [
      "pos.report.read",
      "admin.audit_log.read",
      // 1A (spec:2163 — reads everything financial). Non-mutating only: R7 is a CI test.
      "accounting.ledger.read",
      // 1B (spec:2163 names ledger, documents and reports as the evidence an auditor reads).
      "accounting.report.read",
      // 3A — both mutating: false, so R7 (spec:2178) holds for this role.
      "inventory.item.read",
      "inventory.stock.read",
      // 3B (§3.6.4 — the valuation and cost-layer reads; mutating: false, which is what lets the auditor
      // hold it under R7, spec:2178).
      "inventory.cost.read",
      // 7A — spec:2163 "Read everything financial … and export"; mutating: false, so R7 holds (§3.6.4).
      "accounting.report.export",
      // 7C — spec:2163 "… and export": the tenant data export (spec:2186). Non-mutating, so R7 still holds.
      "admin.data.export",
      // 8B — spec:2163 the payroll register, posted lines only. Non-mutating, so R7 holds.
      "hr.payroll.read",
    ],
  },
  {
    code: "pos_terminal",
    nameEn: "POS terminal",
    nameAr: "نقطة بيع",
    description:
      "Terminal principal reserved exclusively for branch-scoped POS synchronization authority.",
    permissions: ["pos.sync.pull", "pos.sync.push"],
  },
];

export const INCOMPATIBLE_PAIRS: readonly (readonly [string, string])[] = [
  ["accounting.payment.create", "accounting.payment.approve"],
  ["hr.payroll.prepare", "hr.payroll.approve"],
  ["hr.statutory_table.manage", "hr.statutory_table.verify"],
  ["hr.employee.read_sensitive", "pos.ticket.sell"],
];
