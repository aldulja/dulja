export type AggregateConfidence = "verified" | "hypothesis" | "not_derivable";

/** 9B review, finding 8 — one further spelling of a rule's stored-side key and column, complete and in order. */
export interface AggregateSpelling {
  readonly key: readonly string[];
  readonly column: string;
}

export interface AggregateRule {
  /** `<STOREDTABLE>.<STOREDCOLUMN>`, e.g. "ACCTOTALS.DEBIT". */
  readonly id: string;
  readonly storedTable: string;
  readonly storedColumn: string;
  readonly storedKey: readonly string[];
  /** `null` when the routing that produces this column is not derivable from anything we can read. */
  readonly sourceTable: string | null;
  readonly sourceColumn: string | null;
  readonly sourceKey: readonly string[];
  readonly confidence: AggregateConfidence;
  /** Printed on every row of the report. */
  readonly derivation: string;
  readonly legacyDefects: readonly string[];
  /** 9B review, finding 8 — further spellings of `storedKey` + `storedColumn`, tried in order after them; the report
   *  reads the first the source has (`firstSpelling`). Only spellings a 9A or 9B plan writes, never an invented one. */
  readonly storedSpellings?: readonly AggregateSpelling[];
}

const MATTOTALS_ROUTED = [
  "INTERNALDEBIT",
  "INTERNALCREDIT",
  "ORDERDEBIT",
  "ORDERCREDIT",
  "TRANSFERREDDEBIT",
  "TRANSFERREDCREDIT",
] as const;

/**
 * §5.1 #1: "Do not trust stored aggregates. AccTotals, AccObjects, AccCurTotals, MatTotals, MatObjects,
 * MatQuantity, MatCosts, MatStatus are all known to drift (LEGACY-001 → 006, 049, 050). Recompute everything from
 * VouItems/BillItems and reconcile; where the recomputed figure differs from the stored one, report the
 * difference to the customer rather than silently picking one." (spec:2331)
 *
 * The dossier gives these tables' **columns** but not which document-type flags route a line into `Admin*`,
 * `Internal*`, `Order*` or `Transferred*` — that logic lives in the 318 triggers and the fifteen compiled plug-in
 * DLLs, which spec:71 records as **0% examined**. This table does not invent it (hazard 3). Every rule carries its
 * own `derivation` sentence and a `confidence`; the report prints both on every line; and the `not_derivable`
 * rows are the explicit list the owner is asked to confirm. That is what "the difference on every recomputed
 * figure is explained" (spec:2295) means in practice — an unexplained figure is named as unexplained. The table
 * is declarative so that an owner's answer is a data change here, not a code change.
 */
export const AGGREGATE_RULES: readonly AggregateRule[] = [
  {
    id: "ACCTOTALS.DEBIT",
    storedTable: "ACCTOTALS",
    storedColumn: "DEBIT",
    storedKey: ["ACCOUNT"],
    sourceTable: "VOUITEMS",
    sourceColumn: "DEBIT",
    sourceKey: ["ACCOUNT"],
    confidence: "hypothesis",
    derivation: "sum(VOUITEMS.DEBIT) grouped by ACCOUNT, compared with ACCTOTALS.DEBIT",
    legacyDefects: ["LEGACY-001", "LEGACY-002", "LEGACY-011"],
    storedSpellings: [{ key: ["ACTACC"], column: "ACTDEBIT" }],
  },
  {
    id: "ACCTOTALS.CREDIT",
    storedTable: "ACCTOTALS",
    storedColumn: "CREDIT",
    storedKey: ["ACCOUNT"],
    sourceTable: "VOUITEMS",
    sourceColumn: "CREDIT",
    sourceKey: ["ACCOUNT"],
    confidence: "hypothesis",
    derivation: "sum(VOUITEMS.CREDIT) grouped by ACCOUNT, compared with ACCTOTALS.CREDIT",
    legacyDefects: ["LEGACY-001", "LEGACY-002", "LEGACY-011"],
    storedSpellings: [{ key: ["ACTACC"], column: "ACTCREDIT" }],
  },
  {
    id: "ACCTOTALS.ADMINDEBIT",
    storedTable: "ACCTOTALS",
    storedColumn: "ADMINDEBIT",
    storedKey: ["ACCOUNT"],
    sourceTable: null,
    sourceColumn: null,
    sourceKey: [],
    confidence: "not_derivable",
    derivation:
      "which document types route a line into ADMINDEBIT is encoded in the Muniments flags and the 318 triggers; spec:71 records the plug-in DLLs as 0% examined. The owner or a live trigger read must supply the rule.",
    legacyDefects: ["LEGACY-002"],
  },
  {
    id: "ACCTOTALS.ADMINCREDIT",
    storedTable: "ACCTOTALS",
    storedColumn: "ADMINCREDIT",
    storedKey: ["ACCOUNT"],
    sourceTable: null,
    sourceColumn: null,
    sourceKey: [],
    confidence: "not_derivable",
    derivation: "as ACCTOTALS.ADMINDEBIT, on the credit side.",
    legacyDefects: ["LEGACY-002"],
  },
  {
    id: "ACCOBJECTS.DEBIT",
    storedTable: "ACCOBJECTS",
    storedColumn: "DEBIT",
    storedKey: ["SITE", "ACCOUNT"],
    sourceTable: "VOUITEMS",
    sourceColumn: "DEBIT",
    sourceKey: ["SITE", "ACCOUNT"],
    confidence: "hypothesis",
    derivation:
      "sum(VOUITEMS.DEBIT) grouped by (SITE, ACCOUNT), compared with ACCOBJECTS.DEBIT — the trigger the dossier names is OnVouItemsAIUD_Objects.",
    legacyDefects: ["LEGACY-001", "LEGACY-049", "LEGACY-050"],
  },
  {
    id: "ACCOBJECTS.CREDIT",
    storedTable: "ACCOBJECTS",
    storedColumn: "CREDIT",
    storedKey: ["SITE", "ACCOUNT"],
    sourceTable: "VOUITEMS",
    sourceColumn: "CREDIT",
    sourceKey: ["SITE", "ACCOUNT"],
    confidence: "hypothesis",
    derivation: "sum(VOUITEMS.CREDIT) grouped by (SITE, ACCOUNT), compared with ACCOBJECTS.CREDIT.",
    legacyDefects: ["LEGACY-001", "LEGACY-049", "LEGACY-050"],
  },
  {
    id: "ACCOBJECTS.OPENDEBIT",
    storedTable: "ACCOBJECTS",
    storedColumn: "OPENDEBIT",
    storedKey: ["SITE", "ACCOUNT"],
    sourceTable: null,
    sourceColumn: null,
    sourceKey: [],
    confidence: "not_derivable",
    derivation:
      "opening balances are carried forward by a year-end procedure, not accumulated from VouItems; there is no movement history to rebuild them from. The owner supplies the opening position, and 9B posts it as an OPENING_BALANCE document.",
    legacyDefects: ["LEGACY-022"],
  },
  {
    id: "ACCOBJECTS.OPENCREDIT",
    storedTable: "ACCOBJECTS",
    storedColumn: "OPENCREDIT",
    storedKey: ["SITE", "ACCOUNT"],
    sourceTable: null,
    sourceColumn: null,
    sourceKey: [],
    confidence: "not_derivable",
    derivation: "as ACCOBJECTS.OPENDEBIT, on the credit side.",
    legacyDefects: ["LEGACY-022"],
  },
  {
    id: "ACCCURTOTALS.DEBIT",
    storedTable: "ACCCURTOTALS",
    storedColumn: "DEBIT",
    storedKey: ["ACCOUNT", "CUR"],
    sourceTable: "VOUITEMS",
    sourceColumn: "DEBIT",
    sourceKey: ["ACCOUNT", "CUR"],
    confidence: "hypothesis",
    derivation:
      "sum(VOUITEMS.DEBIT) grouped by (ACCOUNT, CUR), compared with ACCCURTOTALS.DEBIT. LEGACY-001 is exactly this table updated without the Site key, so drift here is expected, not surprising.",
    legacyDefects: ["LEGACY-001", "LEGACY-012", "LEGACY-014"],
  },
  {
    id: "ACCCURTOTALS.CREDIT",
    storedTable: "ACCCURTOTALS",
    storedColumn: "CREDIT",
    storedKey: ["ACCOUNT", "CUR"],
    sourceTable: "VOUITEMS",
    sourceColumn: "CREDIT",
    sourceKey: ["ACCOUNT", "CUR"],
    confidence: "hypothesis",
    derivation:
      "sum(VOUITEMS.CREDIT) grouped by (ACCOUNT, CUR), compared with ACCCURTOTALS.CREDIT.",
    legacyDefects: ["LEGACY-001", "LEGACY-012", "LEGACY-014"],
  },
  {
    id: "MATTOTALS.DEBIT",
    storedTable: "MATTOTALS",
    storedColumn: "DEBIT",
    storedKey: ["MATERIAL"],
    sourceTable: "BILLITEMS",
    sourceColumn: "DEBIT",
    sourceKey: ["MATERIAL"],
    confidence: "hypothesis",
    derivation: "sum(BILLITEMS.DEBIT) grouped by MATERIAL, compared with MATTOTALS.DEBIT.",
    legacyDefects: ["LEGACY-004", "LEGACY-006", "LEGACY-016"],
  },
  {
    id: "MATTOTALS.CREDIT",
    storedTable: "MATTOTALS",
    storedColumn: "CREDIT",
    storedKey: ["MATERIAL"],
    sourceTable: "BILLITEMS",
    sourceColumn: "CREDIT",
    sourceKey: ["MATERIAL"],
    confidence: "hypothesis",
    derivation: "sum(BILLITEMS.CREDIT) grouped by MATERIAL, compared with MATTOTALS.CREDIT.",
    legacyDefects: ["LEGACY-004", "LEGACY-006", "LEGACY-016"],
  },
  ...MATTOTALS_ROUTED.map((column): AggregateRule => ({
    id: ["MATTOTALS", column].join("."),
    storedTable: "MATTOTALS",
    storedColumn: column,
    storedKey: ["MATERIAL"],
    sourceTable: null,
    sourceColumn: null,
    sourceKey: [],
    confidence: "not_derivable",
    derivation: [
      "which document types route a BillItems line into",
      ["MATTOTALS", column].join("."),
      "is a Muniments flag combination this project has not read; spec:71 records the plug-in DLLs as 0% examined.",
      "The owner or a live trigger read must supply the rule.",
    ].join(" "),
    legacyDefects: ["LEGACY-004", "LEGACY-018"],
  })),
  {
    id: "MATOBJECTS.QNT",
    storedTable: "MATOBJECTS",
    storedColumn: "QNT",
    storedKey: ["MATERIAL", "WAREHOUSE"],
    sourceTable: "BILLITEMS",
    sourceColumn: "QNT",
    sourceKey: ["MATERIAL", "WAREHOUSE"],
    confidence: "hypothesis",
    derivation:
      "sum(BILLITEMS.QNT) grouped by (MATERIAL, WAREHOUSE), compared with MATOBJECTS.QNT. MatObjects has no key columns at all (LEGACY-049), so a duplicate key here is a finding in its own right — see the duplicate_aggregates report.",
    legacyDefects: ["LEGACY-049", "LEGACY-050"],
  },
  {
    id: "MATQUANTITY.QNT",
    storedTable: "MATQUANTITY",
    storedColumn: "QNT",
    storedKey: ["MATERIAL", "WAREHOUSE", "BATCH"],
    sourceTable: "BILLITEMS",
    sourceColumn: "QNT",
    sourceKey: ["MATERIAL", "WAREHOUSE", "BATCH"],
    confidence: "hypothesis",
    derivation:
      "sum(BILLITEMS.QNT) grouped by (MATERIAL, WAREHOUSE, BATCH), compared with MATQUANTITY.QNT.",
    legacyDefects: ["LEGACY-049", "LEGACY-050"],
  },
  {
    id: "MATCOSTS.COST",
    storedTable: "MATCOSTS",
    storedColumn: "COST",
    storedKey: ["SITE", "MATERIAL"],
    sourceTable: null,
    sourceColumn: null,
    sourceKey: [],
    confidence: "not_derivable",
    derivation:
      "§5.1 #6: do not import cost figures. MatCosts has no rebuild path and multiple corruption routes (LEGACY-004, 007, 008, 009). Cost is recomputed from movement history by the 3B engine at load time and the resulting opening valuation is reconciled with the customer — it is never compared with this column.",
    legacyDefects: ["LEGACY-004", "LEGACY-007", "LEGACY-008", "LEGACY-009"],
  },
  {
    id: "MATCOSTS.BUY",
    storedTable: "MATCOSTS",
    storedColumn: "BUY",
    storedKey: ["SITE", "MATERIAL"],
    sourceTable: null,
    sourceColumn: null,
    sourceKey: [],
    confidence: "not_derivable",
    derivation: "as MATCOSTS.COST (§5.1 #6).",
    legacyDefects: ["LEGACY-004", "LEGACY-008"],
  },
  {
    id: "MATSTATUS.LASTPRICE",
    storedTable: "MATSTATUS",
    storedColumn: "LASTPRICE",
    storedKey: ["SITE", "MATERIAL", "MUNIMENT"],
    sourceTable: null,
    sourceColumn: null,
    sourceKey: [],
    confidence: "not_derivable",
    derivation:
      "MatStatus is an INSERT-only min/max ratchet (LEGACY-016): it records the extreme prices ever seen and is not a function of current rows, so there is nothing to recompute it from.",
    legacyDefects: ["LEGACY-016"],
  },
];
