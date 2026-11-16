import { ReportError } from "@dulja/db";
import { Money, ReportDefinitionError } from "@dulja/domain";
import { PayrollCalculationError } from "@dulja/domain/payroll";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { AppEnv } from "../src/context";
import { toProblemResponse } from "../src/problem";

describe("API problem boundary", () => {
  it("preserves a registered Money domain error in the client problem", async () => {
    const app = new Hono<AppEnv>();
    app.onError((error, context) => toProblemResponse(context, error));
    app.get("/money-mismatch", () => {
      const myr = Money.fromJSON({ amount: "1.0000", currency: "MYR" });
      const usd = Money.fromJSON({ amount: "1.0000", currency: "USD" });
      throw myr.add(usd);
    });

    const response = await app.request("http://example.test/money-mismatch");

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      code: "ERR_MONEY_CURRENCY_MISMATCH",
      detail: "cannot combine MYR with USD",
    });
  });

  // 7A T5 — the two report-engine error classes (contracts §4.2.4): packages/db's ReportError and
  // packages/domain's ReportDefinitionError each become an AppError in exactly one branch.
  it("maps a ReportError to its own code and status, with the detail verbatim", async () => {
    const app = new Hono<AppEnv>();
    app.onError((error, context) => toProblemResponse(context, error));
    app.get("/dataset", () => {
      throw new ReportError(
        "ERR_REPORT_DATASET_UNKNOWN",
        "dataset 'invoices' is not a member of the closed registry",
      );
    });

    const response = await app.request("http://example.test/dataset");

    expect(response.status).toBe(422);
    expect(response.headers.get("content-type")).toBe("application/problem+json");
    await expect(response.json()).resolves.toMatchObject({
      type: "urn:dulja:error:ERR_REPORT_DATASET_UNKNOWN",
      code: "ERR_REPORT_DATASET_UNKNOWN",
      title: "Unknown report dataset",
      detail: "dataset 'invoices' is not a member of the closed registry",
    });
  });

  it("maps a ReportDefinitionError to ERR_VALIDATION_FAILED and carries its JSON-Pointer errors", async () => {
    const app = new Hono<AppEnv>();
    app.onError((error, context) => toProblemResponse(context, error));
    app.get("/definition", () => {
      throw new ReportDefinitionError("report definition is invalid", [
        { path: "/columns/0/field", message: "is not a column of dataset 'ledger_entry'" },
      ]);
    });

    const response = await app.request("http://example.test/definition");

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: "ERR_VALIDATION_FAILED",
      detail: "report definition is invalid",
      errors: [{ path: "/columns/0/field", message: "is not a column of dataset 'ledger_entry'" }],
    });
  });

  // 8B T6 — the payroll calculator's error class (contracts round 17, A9) becomes an AppError in one branch.
  it("maps a PayrollCalculationError to its own code and 422, with the detail verbatim", async () => {
    const app = new Hono<AppEnv>();
    app.onError((error, context) => toProblemResponse(context, error));
    app.get("/payroll", () => {
      throw new PayrollCalculationError(
        "ERR_PAYROLL_INPUT_MISSING",
        "employee emp-1: rate table SYNTH v1 requires statutory input 'x' and the value is null",
      );
    });

    const response = await app.request("http://example.test/payroll");

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      code: "ERR_PAYROLL_INPUT_MISSING",
      title: "Statutory input missing",
      detail:
        "employee emp-1: rate table SYNTH v1 requires statutory input 'x' and the value is null",
    });
  });
});
