import { UpdateReportDefinitionBody } from "@dulja/contracts";
import type { Locale } from "@dulja/i18n";
import { PHYSICAL_PROPERTY_PATTERNS } from "@dulja/ui";
import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { draftErrors, fromDraft, move, toDraft } from "../src/features/reports/draft";
import { ReportDesignRoute } from "../src/routes/reports/$code.design";
import {
  calls,
  CODE,
  COMPANY,
  CORE,
  COPY,
  definition,
  definitionRow,
  fetchMock,
  json,
  mountWith,
  problem,
  sayIn,
  type Handler,
} from "./support/reports";

const LOAD = { timeout: 5000 };
const copyDefinition = definition({
  columns: [
    {
      field: "account_code",
      labelEn: "Account",
      labelAr: "الحساب",
      format: "text",
      align: "start",
      width: 70,
    },
    { field: "debit", labelEn: "Debit", labelAr: "مدين", format: "money", align: "end" },
  ],
});

function designApi(options: { update?: (body: unknown) => Response } = {}) {
  const handler: Handler = (url, init) => {
    const method = init?.method ?? "GET";
    const path = url.pathname;
    if (path.endsWith("/report-definitions"))
      return json({
        items: [
          definitionRow(CORE),
          definitionRow(COPY, { isCore: false, clonedFrom: CORE, definition: copyDefinition }),
        ],
        next_cursor: null,
      });
    if (path.endsWith(`/report-definitions/${COPY}/clone`))
      return json(definitionRow(COPY, { isCore: false, clonedFrom: COPY }), 201);
    if (path.endsWith(`/report-definitions/${CORE}/clone`))
      return json(definitionRow(COPY, { isCore: false, clonedFrom: CORE }), 201);
    if (path.endsWith(`/report-definitions/${COPY}/archive`))
      return new Response(null, { status: 204 });
    if (path.endsWith(`/report-definitions/${CORE}`)) return json(definitionRow(CORE));
    if (path.endsWith(`/report-definitions/${COPY}`) && method === "PUT") {
      const body = JSON.parse(String(init?.body)) as { definition: Record<string, unknown> };
      return options.update
        ? options.update(body)
        : json(
            definitionRow(COPY, { isCore: false, clonedFrom: CORE, definition: body.definition }),
          );
    }
    return problem(404, "ERR_NOT_FOUND");
  };
  return fetchMock(handler);
}

function mountDesign(
  api: ReturnType<typeof designApi>,
  definitionId: string,
  locale: Locale = "en",
) {
  const props = { onBack: vi.fn(), onOpen: vi.fn(), onRun: vi.fn() };
  const user = mountWith(api, locale, (options) => (
    <ReportDesignRoute
      api={options}
      companyId={COMPANY}
      code={CODE}
      definitionId={definitionId}
      {...props}
    />
  ));
  return { user, props, say: sayIn(locale) };
}

describe("7A T15 — the designer's working copy", () => {
  it("brings a dropped column of the source back hidden, and leaves it out of the save", () => {
    const draft = toDraft(copyDefinition, definition());
    expect(draft.columns.map((c) => [c.field, c.shown])).toEqual([
      ["account_code", true],
      ["debit", true],
      ["credit", false],
    ]);
    const built = fromDraft(copyDefinition, { ...draft, columns: move(draft.columns, 2, -2) });
    expect((built.definition["columns"] as { field: string }[]).map((c) => c.field)).toEqual([
      "account_code",
      "debit",
    ]);
    expect(built.columnIndex).toEqual([1, 2]);
    // Everything the designer does not own is sent back as it came.
    expect(built.definition["dataset"]).toEqual(copyDefinition["dataset"]);
    expect(built.definition["parameters"]).toEqual(copyDefinition["parameters"]);
    expect(built.definition["permission"]).toBe("accounting.report.read");
    expect(built.definition["tieOut"]).toEqual({ kind: "none" });
  });

  it("re-keys the API's column errors onto the draft rows", () => {
    expect([
      ...draftErrors(
        new Map([
          ["/columns/0/width", "too small"],
          ["/sort/0/field", "x"],
        ]),
        [1, 2],
      ),
    ]).toEqual([
      ["/columns/1/width", "too small"],
      ["/sort/0/field", "x"],
    ]);
  });
});

describe("7A T15 — the designer", () => {
  it.each(["en", "ar"] as const)(
    "shows a core definition read-only, and Clone opens the copy, in %s",
    async (locale) => {
      const api = designApi();
      const { user, props, say } = mountDesign(api, CORE, locale);
      const clone = await screen.findByRole("button", { name: say("report.designer.clone") }, LOAD);
      await waitFor(() => expect(clone).toHaveFocus());
      expect(screen.getByText(say("report.designer.coreReadOnly"))).toBeVisible();
      expect(screen.getByLabelText(say("report.designer.nameEn"))).toBeDisabled();
      expect(
        screen.queryByRole("button", { name: say("report.designer.save") }),
      ).not.toBeInTheDocument();
      expect(document.documentElement).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
      const classes = [...document.body.querySelectorAll("[class]")]
        .map((e) => e.getAttribute("class"))
        .join(" ");
      for (const pattern of PHYSICAL_PROPERTY_PATTERNS)
        expect(classes).not.toMatch(new RegExp(pattern));
      await user.keyboard("{Enter}");
      await waitFor(() => expect(props.onOpen).toHaveBeenCalledWith(CODE, COPY));
      expect(calls(api, "POST", /\/clone$/)).toHaveLength(1);
      expect(JSON.parse(String(calls(api, "POST", /\/clone$/)[0]![1]!.body))).toEqual({});
    },
  );

  it("edits a copy — a heading, a hidden column, a column shown again and moved — and saves it with Ctrl+S", async () => {
    const api = designApi();
    const { user, say } = mountDesign(api, COPY);
    const title = await screen.findByLabelText(say("report.designer.nameEn"), {}, LOAD);
    await waitFor(() => expect(title).toHaveFocus());
    await user.clear(title);
    await user.keyboard("Trial balance (branch)");
    const columns = screen.getAllByRole("group").filter((g) => g.hasAttribute("data-column"));
    expect(columns).toHaveLength(3);
    // The source's third column comes back hidden; show it, move it first with Alt+Up twice.
    const credit = columns[2]!;
    await user.click(within(credit).getByLabelText(say("report.designer.shown")));
    await user.click(within(credit).getByLabelText(say("report.designer.labelEn")));
    await user.keyboard("{Alt>}{ArrowUp}{/Alt}");
    await waitFor(() =>
      expect(screen.getAllByLabelText(say("report.designer.labelEn"))[1]).toHaveFocus(),
    );
    await user.keyboard("{Alt>}{ArrowUp}{/Alt}");
    await waitFor(() =>
      expect(screen.getAllByLabelText(say("report.designer.labelEn"))[0]).toHaveValue("Credit"),
    );
    // Hide the debit column and widen the account column.
    const now = screen.getAllByRole("group").filter((g) => g.hasAttribute("data-column"));
    await user.click(within(now[2]!).getByLabelText(say("report.designer.shown")));
    const width = within(now[1]!).getByLabelText(say("report.designer.width"));
    await user.clear(width);
    await user.type(width, "120");
    await user.keyboard("{Control>}s{/Control}");
    await waitFor(() => expect(calls(api, "PUT", new RegExp(`/${COPY}$`))).toHaveLength(1));
    const body = JSON.parse(String(calls(api, "PUT", new RegExp(`/${COPY}$`))[0]![1]!.body));
    expect(UpdateReportDefinitionBody.safeParse(body).success).toBe(true);
    expect(body.definition.nameEn).toBe("Trial balance (branch)");
    expect(body.definition.columns.map((c: { field: string }) => c.field)).toEqual([
      "credit",
      "account_code",
    ]);
    expect(body.definition.columns[1].width).toBe(120);
    expect(body.definition.dataset).toEqual(copyDefinition.dataset);
    expect(await screen.findByText(say("report.designer.saved"))).toBeVisible();
  });

  it("shows the API's errors against the field they name, after a hidden column shifts the indices", async () => {
    const api = designApi({
      update: () =>
        problem(400, "ERR_VALIDATION_FAILED", [
          { path: "/columns/0/width", message: "must be >= 8" },
          { path: "/layout/paper", message: "must be one of A4, A5, receipt" },
        ]),
    });
    const { user, say } = mountDesign(api, COPY, "ar");
    await screen.findByLabelText(say("report.designer.nameEn"), {}, LOAD);
    const columns = screen.getAllByRole("group").filter((g) => g.hasAttribute("data-column"));
    // Hide the first column: the saved column 0 is now the draft's second row.
    await user.click(within(columns[0]!).getByLabelText(say("report.designer.shown")));
    await user.click(screen.getByRole("button", { name: say("report.designer.save") }));
    const message = await screen.findByText("must be >= 8");
    expect(columns[1]!).toContainElement(message);
    expect(within(columns[1]!).getByLabelText(say("report.designer.width"))).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    // A pointer with no field of its own is listed in the summary with its path.
    const summary = screen
      .getAllByRole("alert")
      .find((alert) => alert.textContent?.includes(say("problem.ERR_VALIDATION_FAILED.title")))!;
    expect(summary).toHaveTextContent("/layout/paper");
    expect(summary).not.toHaveTextContent("/columns/0/width");
  });

  it("archives a copy only after confirming, then returns to the list", async () => {
    const api = designApi();
    const { user, props, say } = mountDesign(api, COPY);
    await user.click(
      await screen.findByRole("button", { name: say("report.designer.archive") }, LOAD),
    );
    expect(calls(api, "POST", /\/archive$/)).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: say("report.designer.confirmArchive") }));
    await waitFor(() => expect(props.onBack).toHaveBeenCalled());
    expect(calls(api, "POST", /\/archive$/)).toHaveLength(1);
  });

  // UI-06: an unsaved draft is never thrown away without asking.
  it.each(["en", "ar"] as const)(
    "asks before Esc in a text field discards unsaved edits, keyboard only, in %s",
    async (locale) => {
      const { user, props, say } = mountDesign(designApi(), COPY, locale);
      const title = await screen.findByLabelText(say("report.designer.nameEn"), {}, LOAD);
      await waitFor(() => expect(title).toHaveFocus());
      await user.keyboard(" (draft)");
      await user.keyboard("{Escape}");
      expect(props.onBack).not.toHaveBeenCalled();
      const question = screen.getByRole("alertdialog");
      expect(question).toHaveTextContent(say("report.designer.unsavedQuestion"));
      // The safe answer has the cursor: Enter keeps the draft and returns to the field.
      expect(
        within(question).getByRole("button", { name: say("report.designer.keepEditing") }),
      ).toHaveFocus();
      await user.keyboard("{Enter}");
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
      expect(title).toHaveValue(`${copyDefinition.nameEn} (draft)`);
      expect(title).toHaveFocus();
      expect(props.onBack).not.toHaveBeenCalled();
      // Asked again, the operator discards on purpose.
      await user.keyboard("{Escape}");
      within(screen.getByRole("alertdialog"))
        .getByRole("button", { name: say("report.designer.discard") })
        .focus();
      await user.keyboard("{Enter}");
      expect(props.onBack).toHaveBeenCalledTimes(1);
    },
  );

  it("asks before Back, Open or Clone again leave an unsaved draft, and Esc answers the question", async () => {
    const api = designApi();
    const { user, props, say } = mountDesign(api, COPY);
    const title = await screen.findByLabelText(say("report.designer.nameEn"), {}, LOAD);
    await user.type(title, "!");
    for (const name of [
      say("report.back"),
      say("report.open"),
      say("report.designer.cloneAgain"),
    ]) {
      await user.click(screen.getByRole("button", { name }));
      expect(screen.getByRole("alertdialog")).toBeInTheDocument();
      // Esc while the question is open keeps editing; it never leaves.
      await user.keyboard("{Escape}");
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    }
    expect(props.onBack).not.toHaveBeenCalled();
    expect(props.onRun).not.toHaveBeenCalled();
    expect(calls(api, "POST", /\/clone$/)).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: say("report.designer.cloneAgain") }));
    await user.click(screen.getByRole("button", { name: say("report.designer.discard") }));
    await waitFor(() => expect(calls(api, "POST", /\/clone$/)).toHaveLength(1));
    await waitFor(() => expect(props.onOpen).toHaveBeenCalled());
  });

  it("leaves at once when nothing is unsaved", async () => {
    const { user, props, say } = mountDesign(designApi(), COPY);
    await screen.findByLabelText(say("report.designer.nameEn"), {}, LOAD);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(props.onBack).toHaveBeenCalledTimes(1);
  });
});
