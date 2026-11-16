import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  costingEngine,
  currency,
  evaluatePolicy,
  Money,
  parsePolicy,
  Quantity,
  toBase,
  type Consumption,
  type CostingMethod,
  type DocumentSnapshot,
  type Layer,
  type LineSnapshot,
  type PostingPlan,
} from "@dulja/domain";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../support/source";

export interface GoldenLayer {
  movementId: string;
  qtyIn: string;
  unitCost: string;
  qtyRemaining: string;
  effectiveDate: string;
  postingSeq: string;
}
export interface CostingGoldenExpectation {
  plans: PostingPlan[];
  consumptions: Consumption[][];
  layersAfter: GoldenLayer[];
}

const DIR = join(REPO_ROOT, "tests", "golden", "costing");
/** `bun run --cwd tests test -- golden/costing.test.ts` compares; `bun run --cwd tests golden:costing`
 *  (GOLDEN_WRITE=1) regenerates. The regenerator is a DEV script and is not part of CI, so a formula change
 *  shows up as a reviewable diff in the committed expected file rather than being silently rewritten
 *  (spec:2264). */
const WRITE = process.env["GOLDEN_WRITE"] === "1";

/** bigint is not JSON (amendment A7's note). One replacer, used for both directions of the compare. */
const replacer = (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);
const stable = (value: unknown) => JSON.parse(JSON.stringify(value, replacer)) as unknown;

/** One JSON object of the fixture, before rehydration. */
type Wire = Record<string, unknown>;

const money = (value: unknown): Money => {
  const wire = value as { amount: string; currency: string };
  return Money.of(wire.amount, currency(wire.currency));
};
const moneyOrNull = (value: unknown): Money | null => (value == null ? null : money(value));
const quantityOrNull = (value: unknown): Quantity | null =>
  value == null ? null : Quantity.of(value as string);

/**
 * `Money` and `Quantity` arrive from JSON as their wire forms (§4.2.1's `toJSON`) and must become objects
 * before the engine sees them — the fixture is data, and rehydrating it here is what keeps the fixture
 * readable. `header.number` is a `bigint | null` the fixtures never exercise and is forced to `null`;
 * `countedQuantity` and `expectedQuantity` are 3D's stock-count members and are null throughout.
 */
function rehydrate(raw: unknown): DocumentSnapshot[] {
  return (raw as Wire[]).map((document) => {
    const header = document["header"] as Wire;
    const company = document["company"] as Wire;
    const lines = document["lines"] as Wire[];
    return {
      ...(document as unknown as DocumentSnapshot),
      header: {
        ...(header as unknown as DocumentSnapshot["header"]),
        currency: currency(header["currency"] as string),
        number: null,
      },
      company: {
        ...(company as unknown as DocumentSnapshot["company"]),
        baseCurrency: currency(company["baseCurrency"] as string),
      },
      lines: lines.map((line) => ({
        ...(line as unknown as LineSnapshot),
        quantity: quantityOrNull(line["quantity"]),
        unitQuantity: quantityOrNull(line["unitQuantity"]),
        unitPrice: moneyOrNull(line["unitPrice"]),
        discount: money(line["discount"]),
        amount: money(line["amount"]),
        taxAmount: money(line["taxAmount"]),
        totalInclTax: money(line["totalInclTax"]),
        debit: money(line["debit"]),
        credit: money(line["credit"]),
        cost: moneyOrNull(line["cost"]),
        countedQuantity: null,
        expectedQuantity: null,
      })),
    };
  });
}

/**
 * `postDocument` step 9's second half, without a database (contracts §4.3.2, §4.7.2). `applyMovements`
 * writes `document_line.cost` — Σ of the line's ISSUE-movement values when it has any, Σ of its receipt
 * values otherwise, so a transfer line's one cost is the value that left the source — and `postDocument`
 * then re-reads the snapshot and evaluates the policy a SECOND time, keeping the applied movements. Without
 * this pass the committed plan for an issue carries a 0.0000 COGS pair that production never emits: step 6's
 * evaluation runs while `line.cost` is still null (amendment A5), and step 9b refuses exactly that plan. A
 * golden file is "a fixture set of documents with expected ledger output" (spec:2264), so it must hold the
 * ledger the posting service ends with, not the placeholder it starts from.
 *
 * A free-of-charge line resolves to a legitimate zero cost, `evaluatePolicy`'s zero-drop removes its pair,
 * and that document's plan correctly carries no ledger line at all.
 */
function recost(
  policy: ReturnType<typeof parsePolicy>,
  snapshot: DocumentSnapshot,
  plan: PostingPlan,
): PostingPlan {
  const zero = Money.zero(snapshot.company.baseCurrency);
  const perLine = new Map<number, { issue: Money; receipt: Money }>();
  for (const movement of plan.movements) {
    const accumulated = perLine.get(movement.lineNo) ?? { issue: zero, receipt: zero };
    const value = movement.value ?? zero;
    if (movement.effect === "issue") accumulated.issue = accumulated.issue.add(value);
    else accumulated.receipt = accumulated.receipt.add(value);
    perLine.set(movement.lineNo, accumulated);
  }
  const costed: DocumentSnapshot = {
    ...snapshot,
    lines: snapshot.lines.map((line) => {
      const accumulated = perLine.get(line.lineNo);
      if (accumulated === undefined) return line;
      return {
        ...line,
        cost: accumulated.issue.isZero() ? accumulated.receipt : accumulated.issue,
      };
    }),
  };
  return evaluatePolicy(policy, costed);
}

/**
 * The driver. PURE: no clock, no database, no random. It assigns `postingSeq` from the array index — the
 * array is POST order, exactly as `app.posting_seq` would number it — and then sorts by the §4.3.5
 * chronological key before costing anything. A document third in the array carrying January's date
 * therefore costs first, which is what Task 9's replay computes over the same facts.
 */
function run(
  snapshots: DocumentSnapshot[],
  policiesJson: Record<string, unknown>,
  method: CostingMethod,
): CostingGoldenExpectation {
  const policies = Object.fromEntries(
    Object.entries(policiesJson).map(([code, definition]) => [code, parsePolicy(definition)]),
  );
  const numbered = snapshots.map((snapshot, index) => ({
    snapshot,
    postingSeq: BigInt(index + 1),
  }));
  const ordered = [...numbered].toSorted((left, right) =>
    left.snapshot.header.effectiveDate === right.snapshot.header.effectiveDate
      ? left.postingSeq < right.postingSeq
        ? -1
        : 1
      : left.snapshot.header.effectiveDate < right.snapshot.header.effectiveDate
        ? -1
        : 1,
  );

  const layers: Layer[] = [];
  const plans: PostingPlan[] = [];
  const consumptions: Consumption[][] = [];

  for (const { snapshot, postingSeq } of ordered) {
    const policy = policies[snapshot.header.documentTypeCode];
    if (!policy) {
      throw new Error(
        `fixture has no policy for document type ${snapshot.header.documentTypeCode}`,
      );
    }
    let plan = evaluatePolicy(policy, snapshot);
    const linesByNo = new Map(snapshot.lines.map((line) => [line.lineNo, line]));
    const perDocument: Consumption[] = [];
    for (const movement of plan.movements) {
      const movementId = `mv-${postingSeq}-${movement.movementNo}`;
      const open = layers.filter(
        (l) =>
          l.itemId === movement.itemId &&
          l.warehouseId === movement.warehouseId &&
          !l.qtyRemaining.isZero(),
      );
      const line = linesByNo.get(movement.lineNo);
      if (line === undefined) {
        throw new Error(
          `movement ${movement.movementNo} names line ${movement.lineNo}, which the snapshot does not have`,
        );
      }
      const out = costingEngine.cost({
        method,
        openLayers: open,
        allowShortfall: movement.costing === "zero",
        movement: {
          ...movement,
          // The SAME rule as `applyMovements` (Task 7 note 3), keyed on `effect` and not on `costing`: an
          // issue is costed from the layers and its value only tells the engine which currency to answer
          // in. Keying the fixture on `costing === "zero"` instead would make the golden file disagree
          // with the production hook for every ordinary issue, which is the one thing a golden file exists
          // to prevent. A RECEIPT keeps its own money, and `planMovements` emits `value: null` on every
          // movement, so the figure is read off the line exactly as `receiptValue` reads it.
          value:
            movement.effect === "issue"
              ? Money.zero(snapshot.company.baseCurrency)
              : (movement.value ?? toBase(line.amount, snapshot.header.exchangeRate).abs()),
          lotId: movement.lotId ?? "lot-sentinel",
          effectiveDate: snapshot.header.effectiveDate,
          postingSeq,
          movementId,
        },
      });
      perDocument.push(...out.consumptions);
      for (const updated of out.updatedRemaining) {
        const layer = layers.find((l) => l.id === updated.layerId);
        if (layer) layer.qtyRemaining = updated.qtyRemaining;
      }
      if (out.newLayer) layers.push({ ...out.newLayer, id: `L-${movementId}` });
      movement.value = out.value; // the plan as applyMovements returns it
    }
    plan = { ...recost(policy, snapshot, plan), movements: plan.movements };
    plans.push(plan);
    consumptions.push(perDocument);
  }

  return {
    plans,
    consumptions,
    // The OPEN layers, in chronological order — the same set `openLayersFor` returns (`qty_remaining > 0`).
    // An emptied layer is not part of the state a later document costs against, and the plan's own figure
    // table pins this set: `fifo-oldest-first` leaves "one layer, mv-2-1" and `avco-edge-cases` leaves none.
    layersAfter: layers
      .filter((l) => !l.qtyRemaining.isZero())
      .toSorted((left, right) =>
        left.effectiveDate === right.effectiveDate
          ? left.postingSeq < right.postingSeq
            ? -1
            : 1
          : left.effectiveDate < right.effectiveDate
            ? -1
            : 1,
      )
      .map((l) => ({
        movementId: l.movementId,
        qtyIn: l.qtyIn.toString(),
        unitCost: l.unitCost.toString(),
        qtyRemaining: l.qtyRemaining.toString(),
        effectiveDate: l.effectiveDate,
        postingSeq: l.postingSeq.toString(),
      })),
  };
}

function readCase(name: string): {
  input: DocumentSnapshot[];
  policies: Record<string, unknown>;
  method: CostingMethod;
} {
  return {
    input: rehydrate(JSON.parse(readFileSync(join(DIR, name, "input.json"), "utf8"))),
    policies: JSON.parse(readFileSync(join(DIR, name, "policies.json"), "utf8")) as Record<
      string,
      unknown
    >,
    method: name.startsWith("fifo") ? "fifo" : "avco",
  };
}

describe("golden costing fixtures (spec:2264; amendment A7)", () => {
  const cases = readdirSync(DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .toSorted();

  it("there are exactly three cases and each has three files", () => {
    expect(cases).toEqual(["avco-back-dated", "avco-edge-cases", "fifo-oldest-first"]);
    for (const name of cases) {
      expect(readdirSync(join(DIR, name)).toSorted()).toEqual([
        "expected.json",
        "input.json",
        "policies.json",
      ]);
    }
  });

  for (const name of cases) {
    it(`${name} matches its committed expected output byte for byte`, () => {
      const { input, policies, method } = readCase(name);
      const actual = stable(run(input, policies, method));
      if (WRITE) {
        writeFileSync(join(DIR, name, "expected.json"), `${JSON.stringify(actual, null, 2)}\n`);
      }
      const expected = JSON.parse(
        readFileSync(join(DIR, name, "expected.json"), "utf8"),
      ) as unknown;
      expect(actual).toEqual(expected);
    });

    it(`${name} is deterministic — two runs are identical`, () => {
      const first = readCase(name);
      const second = readCase(name);
      expect(JSON.stringify(stable(run(first.input, first.policies, first.method)))).toBe(
        JSON.stringify(stable(run(second.input, second.policies, second.method))),
      );
    });
  }
});
