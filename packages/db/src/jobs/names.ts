export const JOBS = {
  "accounting.ledger.integrity_check": { schedule: "0 2 * * *", owner: "1B" },
  "accounting.projection.rebuild": { schedule: "0 3 * * *", owner: "4B" },
  "inventory.projection.rebuild": { schedule: "0 3 * * *", owner: "3B" },
  "accounting.period.month_end": { schedule: "0 1 1 * *", owner: "1B" },
  "accounting.tax.submit": { schedule: null, owner: "5B" },
  "admin.idempotency_key.purge": { schedule: "*/30 * * * *", owner: "0D" },
  "admin.export.run": { schedule: null, owner: "7C" },
  "admin.import.run": { schedule: null, owner: "9B" },
  "inventory.cost.replay": { schedule: null, owner: "3B" },
  "inventory.lot.expiry_warning": { schedule: "0 6 * * *", owner: "3A" },
  "pos.sync.apply": { schedule: null, owner: "6A" },
  "pos.cashier.compare": { schedule: "30 2 * * *", owner: "6C" },
  "reporting.render": { schedule: null, owner: "7A" },
  "hr.employee_ytd.rebuild": { schedule: "0 4 * * *", owner: "8C" },
  "hr.rate_table.lapse_warning": { schedule: "0 7 * * *", owner: "8A" },
  "hr.encryption_key.rotate": { schedule: null, owner: "8D" },
} as const;
export type JobName = keyof typeof JOBS;
