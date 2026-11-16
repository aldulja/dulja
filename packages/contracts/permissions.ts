export type PermissionModule = "admin" | "accounting" | "inventory" | "hr" | "pos";
export type PermissionAction =
  | "read"
  | "manage"
  | "assign"
  | "create"
  | "post"
  | "approve"
  | "reverse"
  | "close"
  | "reopen"
  | "override"
  | "export"
  | "reconcile"
  | "sell"
  | "discount"
  | "return"
  | "return_blind"
  | "void"
  | "prepare"
  | "pay"
  | "record"
  | "request"
  | "check"
  | "clock"
  | "manage_pin"
  | "resolve"
  | "pull"
  | "push"
  | "file"
  | "generate"
  | "read_sensitive"
  | "verify"
  | "own"
  | "close_any";
export type SliceId =
  | "0B"
  | "0D"
  | "1A"
  | "1B"
  | "2A"
  | "2B"
  | "3A"
  | "3B"
  | "3C"
  | "3D"
  | "4A"
  | "4B"
  | "5A"
  | "5B"
  | "6A"
  | "6B"
  | "6C"
  | "6D"
  | "7A"
  | "7C"
  | "8A"
  | "8B"
  | "8C"
  | "8D";
export interface PermissionDef {
  readonly code: `${PermissionModule}.${string}.${PermissionAction}`;
  readonly module: PermissionModule;
  readonly mutating: boolean;
  readonly description: string;
  readonly phase: SliceId;
}
export const PERMISSIONS = [
  {
    code: "accounting.tax.manage",
    module: "accounting",
    mutating: true,
    description: "Maintain tax regimes and codes, and generate periodic tax returns",
    phase: "5A",
  },

  {
    code: "admin.user.manage",
    module: "admin",
    mutating: true,
    phase: "0B",
    description: "Invite, list, and expire tenant users",
  },
  {
    code: "admin.role.manage",
    module: "admin",
    mutating: true,
    phase: "0B",
    description: "Create roles and manage permissions",
  },
  {
    code: "admin.role.assign",
    module: "admin",
    mutating: true,
    phase: "0B",
    description: "Assign roles within companies",
  },
  {
    code: "admin.company.manage",
    module: "admin",
    mutating: true,
    phase: "0B",
    description: "Create and maintain companies",
  },
  {
    code: "admin.audit_log.read",
    module: "admin",
    mutating: false,
    phase: "0B",
    description: "Read the append-only audit log",
  },
  // ── 7C · tenant data export (contracts §3.6.2, ADR 0069/0070) ────────────────────────────────────────
  {
    code: "admin.data.export",
    module: "admin",
    mutating: false,
    phase: "7C",
    description: "Export the tenant's own data in open formats",
  },
  // ── 1A · accounting (contracts §3.6.2) ─────────────────────────────────────────────────────────────
  {
    code: "accounting.account.manage",
    module: "accounting",
    mutating: true,
    phase: "1A",
    description: "Create, edit and archive chart-of-accounts rows",
  },
  {
    code: "accounting.ledger.read",
    module: "accounting",
    mutating: false,
    phase: "1A",
    description: "Read posted ledger entries and account balances",
  },
  {
    code: "accounting.period.close",
    module: "accounting",
    mutating: true,
    phase: "1A",
    description: "Close a fiscal period so nothing may post into it",
  },
  {
    code: "accounting.period.reopen",
    module: "accounting",
    mutating: true,
    phase: "1A",
    description: "Reopen a closed or locked fiscal period, with a mandatory reason",
  },
  {
    code: "accounting.journal.create",
    module: "accounting",
    mutating: true,
    phase: "1A",
    description: "Draft and edit a journal voucher and its lines",
  },
  {
    code: "accounting.journal.post",
    module: "accounting",
    mutating: true,
    phase: "1A",
    description: "Post a journal voucher to the ledger",
  },
  // ── 1B · accounting reports (contracts §3.6.2) ─────────────────────────────────────────────────────
  {
    code: "accounting.report.read",
    module: "accounting",
    mutating: false,
    phase: "1B",
    description: "Read accounting reports: trial balance and ledger",
  },
  // ── 7A · report export (contracts §3.6.2) ──────────────────────────────────────────────────────────
  {
    code: "accounting.report.export",
    module: "accounting",
    mutating: false,
    phase: "7A",
    description:
      "Export a report as PDF, XLSX or CSV (spec:2146; the auditor's export authority, spec:2163)",
  },
  // ── 2A · accounting parties (contracts §3.6.2) ─────────────────────────────────────────────────────
  {
    code: "accounting.party.manage",
    module: "accounting",
    mutating: true,
    phase: "2A",
    description: "Create, edit and archive customers, vendors and other parties",
  },
  // ── 2B · document lifecycle (contracts §3.6.2) ─────────────────────────────────────────────────────
  {
    code: "accounting.document.reverse",
    module: "accounting",
    mutating: true,
    phase: "2B",
    description:
      "Reverse a posted document, producing the reversing document its policy names (D13, spec:2024)",
  },
  // ── 3A · inventory (contracts §3.6.2) ───────────────────────────────────────────
  {
    code: "inventory.item.read",
    module: "inventory",
    mutating: false,
    phase: "3A",
    description:
      "Read the item master, units, unit conversions, warehouses and lots, and download a lot's attachments",
  },
  {
    code: "inventory.item.manage",
    module: "inventory",
    mutating: true,
    phase: "3A",
    description:
      "Create, edit and archive items, units, unit conversions and warehouses — the head-office catalogue",
  },
  {
    code: "inventory.price.manage",
    module: "inventory",
    mutating: true,
    phase: "3A",
    description: "Create and edit price lists, their lines and promotions",
  },
  {
    code: "inventory.stock.read",
    module: "inventory",
    mutating: false,
    phase: "3A",
    description:
      "Read stock on hand per item, warehouse and lot, and download an inventory document's attachments",
  },
  {
    code: "inventory.negative_stock.override",
    module: "inventory",
    mutating: true,
    phase: "3A",
    description:
      "As a second principal, authorise one document to take stock below zero; recorded as an override document_event",
  },
  // ── 3B · costing (contracts §3.6.2) ─────────────────────────────────────────────
  {
    code: "inventory.cost.read",
    module: "inventory",
    mutating: false,
    phase: "3B",
    description: "Read stock valuation and open cost layers",
  },
  // ── 3C · purchasing and receipts (contracts §3.6.2) ─────────────────────────────
  {
    code: "accounting.purchase.create",
    module: "accounting",
    mutating: true,
    phase: "3C",
    description: "Create and submit purchase orders, import shipments and purchase returns",
  },
  {
    code: "accounting.purchase.post",
    module: "accounting",
    mutating: true,
    phase: "3C",
    description: "Post purchase returns and purchase documents",
  },
  {
    code: "inventory.receipt.create",
    module: "inventory",
    mutating: true,
    phase: "3C",
    description: "Create and submit goods receipts and import shipments",
  },
  {
    code: "inventory.receipt.post",
    module: "inventory",
    mutating: true,
    phase: "3C",
    description: "Post goods receipts and import shipments — quantities and landed cost",
  },
  // ── 3D · outbound documents, transfers, counts and adjustments (contracts §3.6.2) ─
  {
    code: "inventory.transfer.create",
    module: "inventory",
    mutating: true,
    phase: "3D",
    description: "Draft a delivery order, a stock transfer or a transfer receipt",
  },
  {
    code: "inventory.transfer.post",
    module: "inventory",
    mutating: true,
    phase: "3D",
    description:
      "Post a delivery order, a stock transfer or a transfer receipt (stock out, no revenue — F-19)",
  },
  {
    code: "inventory.count.create",
    module: "inventory",
    mutating: true,
    phase: "3D",
    description: "Draft a stock count and enter counted quantities",
  },
  {
    code: "inventory.adjustment.create",
    module: "inventory",
    mutating: true,
    phase: "3D",
    description: "Draft a stock adjustment or an expiry write-off",
  },
  {
    code: "inventory.adjustment.approve",
    module: "inventory",
    mutating: true,
    phase: "3D",
    description: "Approve and post a stock count or an expiry write-off (spec:2026)",
  },
  {
    code: "accounting.sales.create",
    module: "accounting",
    mutating: true,
    phase: "3D",
    description: "Draft a sales order or a sales document",
  },
  // ── 4A · invoices, receipts, payments and credit control (contracts §3.6.2, spec:2147) ─────────────
  {
    code: "accounting.sales.post",
    module: "accounting",
    mutating: true,
    phase: "4A",
    description: "Post sales invoices and sales credit notes",
  },
  {
    code: "accounting.receipt.create",
    module: "accounting",
    mutating: true,
    phase: "4A",
    description: "Create and submit receipts — money in",
  },
  {
    code: "accounting.receipt.post",
    module: "accounting",
    mutating: true,
    phase: "4A",
    description: "Post receipts — money in, no maker-checker (spec:2147)",
  },
  {
    code: "accounting.payment.create",
    module: "accounting",
    mutating: true,
    phase: "4A",
    description: "Draft a payment — money out; incompatible with accounting.payment.approve (R6)",
  },
  {
    code: "accounting.payment.approve",
    module: "accounting",
    mutating: true,
    phase: "4A",
    description: "Approve a payment drafted by another principal (R1, R6)",
  },
  {
    code: "accounting.payment.post",
    module: "accounting",
    mutating: true,
    phase: "4A",
    description: "Post an approved payment — money out",
  },
  {
    code: "accounting.credit_limit.override",
    module: "accounting",
    mutating: true,
    phase: "4A",
    description: "Record a credit-limit override on one document as a second principal (spec:2179)",
  },
  // ── 4B · bank reconciliation (contracts §3.6.2, spec:2147) ─────────────────────────────────────────
  {
    code: "accounting.bank.reconcile",
    module: "accounting",
    mutating: true,
    phase: "4B",
    description:
      "Import bank statements and match or unmatch receipts, payments, till bankings and payroll batches",
  },
  {
    code: "accounting.tax.file",
    module: "accounting",
    mutating: true,
    description: "File a generated tax return and submit or cancel e-invoice transmissions",
    phase: "5B",
  },
  {
    code: "admin.terminal.manage",
    module: "admin",
    mutating: true,
    description: "Issue and revoke POS terminal enrolments",
    phase: "6A",
  },
  {
    code: "pos.shift.close_any",
    module: "pos",
    mutating: true,
    phase: "6D",
    description: "Close a shift opened by another principal",
  },
  {
    code: "pos.report.read",
    module: "pos",
    mutating: false,
    phase: "6D",
    description: "Read POS Z-report, shift history and sales by cashier",
  },
  {
    code: "pos.sync.pull",
    module: "pos",
    mutating: false,
    description: "Pull the branch catalogue to a terminal",
    phase: "6A",
  },
  {
    code: "pos.sync.push",
    module: "pos",
    mutating: true,
    description: "Push a ticket batch from a terminal",
    phase: "6A",
  },
  {
    code: "pos.price.check",
    module: "pos",
    mutating: false,
    phase: "6B",
    description: "Look up an item price at a till without starting a sale",
  },
  {
    code: "pos.shift.own",
    module: "pos",
    mutating: true,
    phase: "6B",
    description: "Open and close one's own till shift",
  },
  {
    code: "pos.attendance.clock",
    module: "pos",
    mutating: true,
    phase: "6B",
    description: "Clock in and out at a till",
  },
  {
    code: "pos.ticket.sell",
    module: "pos",
    mutating: true,
    description: "Sell at a till",
    phase: "6A",
  },
  {
    code: "pos.ticket.discount",
    module: "pos",
    mutating: true,
    description: "Discount a line or a ticket within the branch limit",
    phase: "6A",
  },
  {
    code: "pos.ticket.return",
    module: "pos",
    mutating: true,
    description: "Return against an original ticket",
    phase: "6A",
  },
  {
    code: "pos.ticket.return_blind",
    module: "pos",
    mutating: true,
    description: "Return with no original ticket",
    phase: "6A",
  },
  {
    code: "pos.ticket.void",
    module: "pos",
    mutating: true,
    description: "Void a ticket",
    phase: "6A",
  },
  {
    code: "pos.ticket.override",
    module: "pos",
    mutating: true,
    description: "Authorise, as a second principal, a ticket beyond a cashier's limit",
    phase: "6A",
  },
  {
    code: "pos.needs_attention.resolve",
    module: "pos",
    mutating: true,
    description: "Resolve a refused ticket in the shop queue",
    phase: "6A",
  },
  {
    code: "pos.customer.create",
    module: "pos",
    mutating: true,
    description: "Quick-create a customer at a till",
    phase: "6A",
  },

  {
    code: "hr.employee.read",
    module: "hr",
    mutating: false,
    phase: "6C",
    description:
      "Read the staff directory: employee number, home branch, hire and termination dates. No sensitive or compensation fields.",
  },
  {
    code: "hr.employee.manage",
    module: "hr",
    mutating: true,
    phase: "6C",
    description: "Create and maintain the employee master.",
  },
  {
    code: "hr.attendance.record",
    module: "hr",
    mutating: true,
    phase: "6C",
    description: "Record and correct attendance events in the back office.",
  },
  {
    code: "pos.cashier.manage_pin",
    module: "pos",
    mutating: true,
    phase: "6C",
    description: "Set or reset a cashier's till PIN, within the branches the actor is assigned to.",
  },
  // 8A — §3.6.2's six codes, in its order (migration 0086). The two read* codes are non-mutating.
  {
    code: "hr.employee.read_sensitive",
    module: "hr",
    mutating: false,
    phase: "8A",
    description:
      "Read an employee's identity, bank and statutory reference numbers. Gated in the data layer by the sensitive_gate RLS policy, not only by this pre-flight — which is why it also gates the WRITE without being a mutating code: sensitive_gate has no `with check`, so its `using` predicate applies to writes too.",
  },
  {
    code: "hr.compensation.read",
    module: "hr",
    mutating: false,
    phase: "8A",
    description:
      "Read compensation lines and effective-dated statutory profiles. Posted payroll amounts are a different code (hr.payroll.read).",
  },
  {
    code: "hr.compensation.manage",
    module: "hr",
    mutating: true,
    phase: "8A",
    description:
      "Open and close compensation lines and statutory profiles, and write an employee's sensitive record. The sensitive write additionally passes sensitive_gate, which requires hr.employee.read_sensitive. R4 forbids acting on your own record.",
  },
  {
    code: "hr.pay_component.manage",
    module: "hr",
    mutating: true,
    phase: "8A",
    description: "Maintain the pay-component catalogue and its statutory-scheme joins.",
  },
  {
    code: "hr.statutory_table.manage",
    module: "hr",
    mutating: true,
    phase: "8A",
    description:
      "Break-glass load of a statutory rate table outside the seed pull request. The loader is recorded in loaded_by and cannot verify its own table.",
  },
  {
    code: "hr.statutory_table.verify",
    module: "hr",
    mutating: true,
    phase: "8A",
    description:
      "Verify a loaded statutory rate table. Refused when the verifying principal is the one recorded in loaded_by (ERR_HR_SELF_VERIFY).",
  },
  // 8B — §3.6.2's four payroll codes (migration 0089). Only the read code is non-mutating (R7 lets the auditor
  // hold it). The PAYROLL policy names the other three as approval.create / .approve / .post.
  {
    code: "hr.payroll.read",
    module: "hr",
    mutating: false,
    phase: "8B",
    description:
      "Read payroll runs and posted payroll lines (spec:2163 — the auditor sees posted lines only, never compensation or sensitive rows).",
  },
  {
    code: "hr.payroll.prepare",
    module: "hr",
    mutating: true,
    phase: "8B",
    description:
      "Calculate, recalculate and submit a payroll run (spec:2162 — the HR officer prepares; R6 forbids the same seeded role also approving).",
  },
  {
    code: "hr.payroll.approve",
    module: "hr",
    mutating: true,
    phase: "8B",
    description:
      "Approve a submitted payroll run (spec:2172 R1/R2 — the checker, who must not be the submitter).",
  },
  {
    code: "hr.payroll.post",
    module: "hr",
    mutating: true,
    phase: "8B",
    description: "Post an approved payroll run through the posting service (spec:2173 R2).",
  },
  // 8C — §3.6.2's two money-out codes (migration 0095). Each is the approval.create of one hr-module document type
  // (PAYROLL_PAYMENT, EMPLOYEE_ADVANCE); approval and posting stay accounting.payment.approve / .post (spec:2082).
  {
    code: "hr.payroll.pay",
    module: "hr",
    mutating: true,
    phase: "8C",
    description: "Release a payroll payment batch and settle a statutory remittance",
  },
  {
    code: "hr.advance.create",
    module: "hr",
    mutating: true,
    phase: "8C",
    description: "Create a staff advance",
  },
  // 8D — §3.6.2's one unconditional code (migration 0097). It gates producing a filing from POSTED payroll figures —
  // the payslip PDFs of 8D Task 5. The two hr.leave.* codes of OD-13 are inserted by 0096 with the tables they gate
  // (contracts round 19, 8D A9), so they land in Task 8, not here.
  {
    code: "hr.filing.generate",
    module: "hr",
    mutating: true,
    phase: "8D",
    description:
      "Generate a payslip, a statutory schedule document or an annual statement from posted payroll figures",
  },
  // 8D Task 8 — ⚠️ OD-13, answered BUILD on 2026-11-07 (contracts round 19, 8D A14). The two leave codes of §3.6.2,
  // inserted by migration 0096 with the tables they gate (8D A9), so the whole leave gate is one file and one task.
  // R4 (spec:2175) binds the approve code per row in the data layer: nobody approves their own leave.
  {
    code: "hr.leave.record",
    module: "hr",
    mutating: true,
    phase: "8D",
    description: "Record a leave request, an entitlement, a leave type or a public holiday",
  },
  {
    code: "hr.leave.approve",
    module: "hr",
    mutating: true,
    phase: "8D",
    description: "Approve or reject a leave record for someone other than oneself",
  },
] as const satisfies readonly PermissionDef[];
export type PermissionCode = (typeof PERMISSIONS)[number]["code"];
export const PERMISSION = Object.fromEntries(PERMISSIONS.map((item) => [item.code, item.code])) as {
  readonly [K in PermissionCode]: K;
};
export function isMutating(code: PermissionCode): boolean {
  return PERMISSIONS.find((item) => item.code === code)?.mutating ?? true;
}

/** Derived counterpart of the SQL offline projection; terminal sync codes are excluded. */
export const CASHIER_SNAPSHOT_CODES: readonly PermissionCode[] = PERMISSIONS.filter(
  (p) => p.module === "pos" && !p.code.startsWith("pos.sync."),
).map((p) => p.code);
