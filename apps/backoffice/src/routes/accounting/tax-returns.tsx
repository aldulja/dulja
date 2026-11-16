import { CreateTaxReturnBody, type TaxReturnDto } from "@dulja/contracts";
import { formatDate, formatMoney } from "@dulja/i18n";
import { Button, DataGrid, Select, TextField, type Column } from "@dulja/ui";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useShell } from "../../components/app-shell";
import type { AdminApiOptions } from "../../lib/admin-api";
import {
  ApiError,
  isAalRefusal,
  isSessionRefusal,
  problemSegments,
  retryQuery,
} from "../../lib/problem";
import { keepsAttemptKey } from "../../features/reports/shared";
import { COMPANY_QUERY_KEY } from "../../lib/session";
import { createTaxApi } from "../../lib/tax-api";

/** A company/session switch discards forms and in-flight presentation state, including retry keys. */
export function TaxReturnsRoute(props: { api: AdminApiOptions; companyId: string }) {
  return <CompanyReturns key={props.companyId} {...props} />;
}

function CompanyReturns({ api, companyId }: { api: AdminApiOptions; companyId: string }) {
  const { t, locale } = useShell();
  const client = useMemo(() => createTaxApi(api, companyId), [api, companyId]);
  const cache = useQueryClient();
  const navigate = useNavigate();
  const enabled = companyId !== "" && api.accessToken() !== null;
  const [filter, setFilter] = useState("");
  const [regime, setRegime] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const [invalid, setInvalid] = useState(false);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const alive = useRef(true);
  const restoreFocus = useRef<HTMLElement | null>(null);
  const dateField = useRef<HTMLInputElement>(null);
  const filterField = useRef<HTMLInputElement>(null);
  const selection = useRef(selected);
  selection.current = selected;
  const attempts = useRef(new Map<string, string>());
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    if (busy) return;
    const target = restoreFocus.current;
    restoreFocus.current = null;
    if (
      target?.isConnected &&
      (document.activeElement === document.body || document.activeElement === target)
    )
      target.focus();
  }, [busy]);
  const prefix = ["tax-returns", companyId] as const;
  const codes = useInfiniteQuery({
    queryKey: ["tax-codes", companyId],
    enabled,
    retry: retryQuery,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => client.codes(pageParam, { signal }),
    getNextPageParam: (page) => page.next_cursor,
  });
  // Regime selection must cover every code page, including regimes after the first 1,000 codes.
  useEffect(() => {
    if (codes.hasNextPage && !codes.isFetchingNextPage && !codes.isFetchNextPageError)
      void codes.fetchNextPage();
  }, [
    codes.hasNextPage,
    codes.isFetchingNextPage,
    codes.isFetchNextPageError,
    codes.fetchNextPage,
  ]);
  const regimes = useMemo(
    () => [
      ...new Map(
        (codes.data?.pages.flatMap((p) => p.items) ?? []).map((c) => [
          `${c.regimeCode}:${c.regimeVersion}`,
          { code: c.regimeCode, version: c.regimeVersion },
        ]),
      ).entries(),
    ],
    [codes.data],
  );
  const chosen = regimes.find(([key]) => key === regime)?.[1];
  const returns = useInfiniteQuery({
    queryKey: [...prefix, "list", filter],
    enabled,
    retry: retryQuery,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => client.returns(filter, pageParam, { signal }),
    getNextPageParam: (page) => page.next_cursor,
  });
  const detailKey = [...prefix, "detail", selected];
  const detail = useQuery({
    queryKey: detailKey,
    enabled: enabled && selected !== null,
    retry: retryQuery,
    queryFn: ({ signal }) => client.detail(selected!, { signal }),
  });
  const error = failure ?? codes.error ?? returns.error ?? detail.error;
  useEffect(() => {
    if (isSessionRefusal(error)) void cache.invalidateQueries({ queryKey: COMPANY_QUERY_KEY });
    else if (isAalRefusal(error)) void navigate({ to: "/mfa" });
  }, [error, cache, navigate]);

  function newReturn() {
    if (lock.current) return;
    setSelected(null);
    setFailure(null);
    setInvalid(false);
    setRegime("");
    setStart("");
    setEnd("");
    dateField.current?.focus();
  }
  async function mutate(action: "create" | "generate") {
    if (!enabled || lock.current) return;
    const id = selected;
    const body = CreateTaxReturnBody.safeParse({
      regimeCode: chosen?.code,
      regimeVersion: chosen?.version,
      periodStart: start,
      periodEnd: end,
    });
    if (action === "create" && !body.success) {
      setInvalid(true);
      dateField.current?.focus();
      return;
    }
    if (
      action === "generate" &&
      (id === null || detail.isFetching || !detail.data || detail.data.taxReturn.status === "filed")
    )
      return;
    const gesture = action === "create" ? `create:${JSON.stringify(body.data)}` : `generate:${id}`;
    const key = attempts.current.get(gesture) ?? crypto.randomUUID();
    attempts.current.set(gesture, key);
    restoreFocus.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    lock.current = true;
    setBusy(true);
    setFailure(null);
    setInvalid(false);
    try {
      if (action === "create" && body.success) {
        const row = await client.create(body.data, { idempotencyKey: key });
        if (!alive.current) return;
        setFilter("");
        setSelected(row.id);
      } else if (id !== null) {
        const targetKey = [...prefix, "detail", id];
        await cache.cancelQueries({ queryKey: targetKey });
        const result = await client.generate(id, { idempotencyKey: key });
        if (!alive.current) return;
        cache.setQueryData(targetKey, result);
      }
      attempts.current.delete(gesture);
      if (alive.current) await cache.invalidateQueries({ queryKey: [...prefix, "list"] });
    } catch (cause) {
      // A definite answer is recorded under this key, so a corrected retry needs a fresh one; an
      // unknown outcome or an attempt still in flight keeps it (`keepsAttemptKey`, UI-09/UI-12).
      if (!keepsAttemptKey(cause)) attempts.current.delete(gesture);
      if (alive.current && (action === "create" || selection.current === id)) setFailure(cause);
    } finally {
      lock.current = false;
      if (alive.current) setBusy(false);
    }
  }
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.altKey || event.metaKey || event.repeat) return;
      const key = event.key.toLowerCase();
      if (event.ctrlKey && ["n", "g", "s"].includes(key)) {
        event.preventDefault();
        if (key === "n") newReturn();
        else void mutate(key === "g" ? "generate" : "create");
      } else if (
        !event.ctrlKey &&
        event.key === "Escape" &&
        !lock.current &&
        !(event.target instanceof HTMLSelectElement)
      ) {
        newReturn();
      } else if (
        !event.ctrlKey &&
        key === "/" &&
        !(
          event.target instanceof HTMLElement &&
          (event.target.isContentEditable ||
            ["INPUT", "SELECT", "TEXTAREA"].includes(event.target.tagName))
        )
      ) {
        event.preventDefault();
        filterField.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  const columns: Column<TaxReturnDto>[] = [
    { key: "regime", header: t("tax.regime"), cell: (r) => `${r.regimeCode} v${r.regimeVersion}` },
    { key: "start", header: t("tax.start"), cell: (r) => formatDate(r.periodStart, { locale }) },
    { key: "end", header: t("tax.end"), cell: (r) => formatDate(r.periodEnd, { locale }) },
    { key: "status", header: t("tax.status"), cell: (r) => t(`tax.status.${r.status}`) },
    {
      key: "open",
      header: t("tax.open"),
      cell: (r) => (
        <Button
          onClick={() => {
            setSelected(r.id);
            setFailure(null);
          }}
        >
          {t("tax.open")}
        </Button>
      ),
    },
  ];
  const money = (amount: string) => (
    <bdi dir="ltr">
      {formatMoney({ amount, currency: detail.data!.currency }, { locale }, { minorUnits: 4 })}
    </bdi>
  );
  return (
    <section className="flex flex-col gap-6" aria-label={t("tax.title")}>
      <h1 className="text-start text-xl font-bold">{t("tax.title")}</h1>
      <div className="flex flex-wrap items-end gap-3">
        <Button onClick={newReturn} disabled={busy} aria-keyshortcuts="Control+n">
          {t("tax.new")}
        </Button>
        <TextField
          ref={filterField}
          label={t("tax.filter")}
          value={filter}
          onChange={(e) => setFilter(e.currentTarget.value)}
        />
      </div>
      {error ? (
        <div role="alert" className="text-start text-danger">
          {(error instanceof ApiError
            ? problemSegments(error.problem, t)
            : [{ key: "error", text: t("app.error.title") }]
          ).map((p) => (
            <p key={p.key}>
              <bdi>{p.text}</bdi>
            </p>
          ))}
          <Button
            onClick={() => {
              setFailure(null);
              void codes.refetch();
              void returns.refetch();
              if (selected) void detail.refetch();
            }}
          >
            {t("app.error.retry")}
          </Button>
        </div>
      ) : null}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void mutate("create");
        }}
        className="flex flex-wrap items-end gap-3"
        aria-label={t("tax.new")}
      >
        <Select
          label={t("tax.regime")}
          value={regime}
          disabled={!enabled || busy || codes.hasNextPage}
          options={[
            { value: "", label: t("tax.choose") },
            ...regimes.map(([value, r]) => ({ value, label: `${r.code} v${r.version}` })),
          ]}
          onChange={(e) => setRegime(e.currentTarget.value)}
        />
        <TextField
          ref={dateField}
          type="date"
          label={t("tax.start")}
          required
          value={start}
          disabled={busy}
          onChange={(e) => setStart(e.currentTarget.value)}
        />
        <TextField
          type="date"
          label={t("tax.end")}
          required
          min={start || undefined}
          value={end}
          disabled={busy}
          onChange={(e) => setEnd(e.currentTarget.value)}
        />
        <Button type="submit" disabled={!enabled || busy || !chosen} aria-keyshortcuts="Control+s">
          {t("tax.create")}
        </Button>
      </form>
      {invalid ? (
        <p role="alert" className="text-danger">
          {t("tax.invalid")}
        </p>
      ) : null}
      {codes.isPending || returns.isPending ? <p role="status">{t("app.loading")}</p> : null}
      <DataGrid
        caption={t("tax.list")}
        columns={columns}
        rows={returns.data?.pages.flatMap((p) => p.items) ?? []}
        rowKey={(r) => r.id}
        emptyLabel={t("app.empty")}
        onActivate={(r) => {
          setSelected(r.id);
          setFailure(null);
        }}
      />
      {returns.hasNextPage ? (
        <Button disabled={returns.isFetchingNextPage} onClick={() => void returns.fetchNextPage()}>
          {t("tax.more")}
        </Button>
      ) : null}
      {codes.isFetchNextPageError ? (
        <Button onClick={() => void codes.fetchNextPage()}>{t("app.error.retry")}</Button>
      ) : null}
      {selected !== null ? (
        <section
          className="flex flex-col gap-4"
          aria-label={t("tax.detail")}
          aria-busy={busy || detail.isFetching}
        >
          <h2 className="text-lg font-bold">{t("tax.detail")}</h2>
          {detail.isPending ? <p role="status">{t("app.loading")}</p> : null}
          {detail.data ? (
            <>
              <p>
                <bdi>
                  {detail.data.taxReturn.regimeCode} v{detail.data.taxReturn.regimeVersion}
                </bdi>{" "}
                · <bdi>{formatDate(detail.data.taxReturn.periodStart, { locale })}</bdi> –{" "}
                <bdi>{formatDate(detail.data.taxReturn.periodEnd, { locale })}</bdi> ·{" "}
                {t(`tax.status.${detail.data.taxReturn.status}`)}
              </p>
              <Button
                disabled={busy || detail.isFetching || detail.data.taxReturn.status === "filed"}
                onClick={() => void mutate("generate")}
                aria-keyshortcuts="Control+g"
              >
                {t("tax.generate")}
              </Button>
              <DataGrid
                caption={t("tax.boxes")}
                columns={[
                  { key: "code", header: t("tax.code"), cell: (r) => r.code },
                  { key: "label", header: t("tax.label"), cell: (r) => r.label },
                  {
                    key: "amount",
                    header: t("tax.amount"),
                    align: "end",
                    cell: (r) => money(r.amount),
                  },
                ]}
                rows={detail.data.boxes}
                rowKey={(r) => r.code}
                emptyLabel={t("tax.draft")}
              />
              <table className="w-full border-collapse text-start" data-testid="tax-reconciliation">
                <caption className="text-start text-text-muted">{t("tax.reconciliation")}</caption>
                <thead>
                  <tr>
                    {["account", "boxBase", "ledgerBase", "difference"].map((k) => (
                      <th
                        key={k}
                        scope="col"
                        className={k === "account" ? "text-start" : "text-end"}
                      >
                        {t(
                          `tax.${k}` as
                            | "tax.account"
                            | "tax.boxBase"
                            | "tax.ledgerBase"
                            | "tax.difference",
                        )}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {detail.data.tieOut.map((r) => (
                    <tr
                      key={r.accountCode}
                      className={
                        /^-?0\.0+$/.test(r.difference)
                          ? "border-b border-border"
                          : "border-b border-danger text-danger"
                      }
                    >
                      <th scope="row" className="text-start py-2">
                        <bdi>{r.accountCode}</bdi>
                      </th>
                      <td className="text-end">{money(r.boxBase)}</td>
                      <td className="text-end">{money(r.ledgerBase)}</td>
                      <td className="text-end">
                        {money(r.difference)}
                        {/^-?0\.0+$/.test(r.difference) ? null : (
                          <span className="ms-2">{t("tax.mismatch")}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {detail.data.taxReturn.payloadSha256 ? (
                <p className="break-all text-start text-text-muted">
                  {t("tax.hash")}: <bdi dir="ltr">{detail.data.taxReturn.payloadSha256}</bdi>
                </p>
              ) : null}
            </>
          ) : null}
        </section>
      ) : null}
    </section>
  );
}
