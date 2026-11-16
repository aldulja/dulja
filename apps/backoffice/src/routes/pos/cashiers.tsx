import { CreateCashierBody, SetPinBody, type CashierDto } from "@dulja/contracts/pos/cashier";
import { Button, DataGrid, Select, TextField, type Column } from "@dulja/ui";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useShell } from "../../components/app-shell";
import { StaffFailure } from "../../components/staff-failure";
import { StaffContextPicker, type StaffCompany } from "../../components/staff-context";
import { keepsAttemptKey } from "../../features/reports/shared";
import type { AdminApiOptions } from "../../lib/admin-api";
import { staffApi } from "../../lib/staff-api";
import { retryQuery } from "../../lib/problem";

export function CashiersRoute({ api }: { api: AdminApiOptions }) {
  return (
    <StaffContextPicker api={api}>
      {(company) => <CashierDirectory api={api} company={company} />}
    </StaffContextPicker>
  );
}
function CashierDirectory({ api, company }: { api: AdminApiOptions; company: StaffCompany }) {
  const { t, locale } = useShell();
  const client = useMemo(() => staffApi(api, company.id), [api, company.id]);
  const [branchId, setBranchId] = useState(company.branches[0]?.id ?? "");
  const [selected, setSelected] = useState<CashierDto | null>(null);
  const [creating, setCreating] = useState(false);
  const restore = useRef<HTMLElement | null>(null);
  const cashiers = useInfiniteQuery({
    queryKey: ["staff-cashiers", company.id, branchId],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => client.cashiers(branchId, pageParam, { signal }),
    getNextPageParam: (page) => page.next_cursor,
    retry: retryQuery,
  });
  const employees = useInfiniteQuery({
    queryKey: ["staff-cashier-employees", company.id],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => client.employees("", pageParam, { signal }),
    getNextPageParam: (page) => page.next_cursor,
    retry: retryQuery,
  });
  useEffect(() => {
    if (cashiers.hasNextPage && !cashiers.isFetchingNextPage && !cashiers.isFetchNextPageError)
      void cashiers.fetchNextPage();
  }, [
    cashiers.hasNextPage,
    cashiers.isFetchingNextPage,
    cashiers.isFetchNextPageError,
    cashiers.fetchNextPage,
  ]);
  useEffect(() => {
    if (employees.hasNextPage && !employees.isFetchingNextPage && !employees.isFetchNextPageError)
      void employees.fetchNextPage();
  }, [
    employees.hasNextPage,
    employees.isFetchingNextPage,
    employees.isFetchNextPageError,
    employees.fetchNextPage,
  ]);
  const people = employees.data?.pages.flatMap((page) => page.items) ?? [];
  // `POST /cashiers` refuses a terminated employee and one who already signs in (ERR_CONFLICT_UNIQUE).
  const eligible = people.filter(
    (employee) => !employee.terminatedOn && employee.principalId === null,
  );
  const numberOf = (row: CashierDto): string =>
    row.employeeNumber ??
    people.find((employee) => employee.id === row.employeeId)?.employeeNumber ??
    t("staff.unavailableEmployee");
  const columns: Column<CashierDto>[] = [
    // The row's own bounded employee-number projection comes first: a PIN manager may be refused the
    // ordinary employee directory and must still be able to tell which credential they are resetting.
    {
      key: "employee",
      header: t("staff.employeeNumber"),
      cell: numberOf,
    },
    {
      key: "status",
      header: t("staff.status"),
      cell: (row) => t(row.revokedAt ? "staff.revoked" : "staff.active"),
    },
  ];
  function close() {
    setSelected(null);
    setCreating(false);
    queueMicrotask(() => {
      if (restore.current?.isConnected) restore.current.focus();
    });
  }
  return (
    <section
      className="flex flex-col gap-4"
      onKeyDown={(event) => {
        if (event.key === "Escape" && (selected || creating)) {
          event.preventDefault();
          close();
        }
      }}
    >
      <h1>{t("staff.cashiers")}</h1>
      <Select
        label={t("staff.branch")}
        value={branchId}
        options={company.branches.map((branch) => ({
          value: branch.id,
          label: locale === "ar" ? (branch.nameAr ?? branch.nameEn) : branch.nameEn,
        }))}
        onChange={(event) => {
          setSelected(null);
          setCreating(false);
          setBranchId(event.currentTarget.value);
        }}
      />
      <Button
        onClick={(event) => {
          restore.current = event.currentTarget;
          setSelected(null);
          setCreating(true);
        }}
        disabled={eligible.length === 0}
      >
        {t("staff.createCashier")}
      </Button>
      {cashiers.error ||
      employees.error ||
      cashiers.isFetchNextPageError ||
      employees.isFetchNextPageError ? (
        <p role="alert">{t("staff.loadFailed")}</p>
      ) : null}
      <DataGrid
        caption={t("staff.cashiers")}
        columns={columns}
        rows={cashiers.data?.pages.flatMap((page) => page.items) ?? []}
        rowKey={(row) => row.principalId}
        emptyLabel={t("staff.noCashiers")}
        onActivate={(row) => {
          restore.current = document.activeElement as HTMLElement;
          setSelected(row);
          setCreating(false);
        }}
      />
      {selected || creating ? (
        <CredentialPanel
          key={selected?.principalId ?? "new"}
          client={client}
          branchId={branchId}
          cashier={selected}
          cashierLabel={selected ? numberOf(selected) : ""}
          employeeOptions={eligible.map((employee) => ({
            value: employee.id,
            label: employee.employeeNumber,
          }))}
          onClose={close}
          onSaved={() => {
            close();
            void cashiers.refetch();
            // A created credential links its employee, who must then drop out of `eligible`.
            if (!selected) void employees.refetch();
          }}
        />
      ) : null}
    </section>
  );
}
function CredentialPanel({
  client,
  branchId,
  cashier,
  cashierLabel,
  employeeOptions,
  onSaved,
  onClose,
}: {
  client: ReturnType<typeof staffApi>;
  branchId: string;
  cashier: CashierDto | null;
  /** The employee number the list shows for this credential, named in the revoke question (UI-19). */
  cashierLabel: string;
  employeeOptions: readonly { value: string; label: string }[];
  onSaved: () => void;
  onClose: () => void;
}) {
  const { t } = useShell();
  const [employeeId, setEmployeeId] = useState(employeeOptions[0]?.value ?? "");
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const pinRef = useRef<HTMLInputElement>(null);
  const revokeRef = useRef<HTMLButtonElement>(null);
  const cancelRevokeRef = useRef<HTMLButtonElement>(null);
  const controller = useRef(new AbortController());
  const lock = useRef(false);
  const attempts = useRef(new Map<string, string>());
  useEffect(() => {
    const active = new AbortController();
    controller.current = active;
    if (cashier) pinRef.current?.focus();
    return () => active.abort();
  }, [cashier]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setFailure(null);
    let digest: string | undefined;
    try {
      const body = cashier
        ? SetPinBody.parse({ pin })
        : CreateCashierBody.parse({ employeeId, branchId, email, displayName, pin });
      // Retain a digest for retry identity, never the plaintext PIN or request body.
      digest = Array.from(
        new Uint8Array(
          await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(body))),
        ),
        (byte) => byte.toString(16).padStart(2, "0"),
      ).join("");
      const idempotencyKey = attempts.current.get(digest) ?? crypto.randomUUID();
      attempts.current.set(digest, idempotencyKey);
      setPin("");
      if (cashier)
        await client.setPin(cashier.principalId, SetPinBody.parse(body), {
          idempotencyKey,
          signal: controller.current.signal,
        });
      else
        await client.createCashier(CreateCashierBody.parse(body), {
          idempotencyKey,
          signal: controller.current.signal,
        });
      if (!controller.current.signal.aborted) onSaved();
    } catch (cause) {
      // A definite answer is what the server recorded under the key, so a corrected retry needs a fresh one;
      // only an unknown outcome or an in-flight attempt keeps it (`keepsAttemptKey`, §4.2.9).
      if (digest !== undefined && !keepsAttemptKey(cause)) attempts.current.delete(digest);
      if (!controller.current.signal.aborted) setFailure(cause);
    } finally {
      lock.current = false;
      if (!controller.current.signal.aborted) {
        setBusy(false);
        setPin("");
      }
    }
  }
  async function revoke() {
    if (!cashier || lock.current) return;
    lock.current = true;
    setConfirmRevoke(false);
    setBusy(true);
    setFailure(null);
    setPin("");
    // One key per panel, held across retries like the submit's (spec:2055). Never derived from the
    // principal: the API replays a recorded refusal for the key's whole retention, so a fixed key
    // would answer every later revoke of this credential with the first attempt's 403.
    const idempotencyKey = attempts.current.get("revoke") ?? crypto.randomUUID();
    attempts.current.set("revoke", idempotencyKey);
    try {
      await client.revokeCashier(cashier.principalId, {
        idempotencyKey,
        signal: controller.current.signal,
      });
      if (!controller.current.signal.aborted) onSaved();
    } catch (cause) {
      if (!keepsAttemptKey(cause)) attempts.current.delete("revoke");
      if (!controller.current.signal.aborted) setFailure(cause);
    } finally {
      lock.current = false;
      if (!controller.current.signal.aborted) setBusy(false);
    }
  }
  function askRevoke(open: boolean) {
    setConfirmRevoke(open);
    // The safe answer takes focus, so a second Enter cannot revoke; cancelling returns to the Revoke button.
    queueMicrotask(() => (open ? cancelRevokeRef : revokeRef).current?.focus());
  }
  return (
    <form
      aria-label={t(cashier ? "staff.resetPin" : "staff.createCashier")}
      onSubmit={(event) => {
        void submit(event);
      }}
      className="flex flex-col gap-3"
    >
      {!cashier ? (
        <>
          <Select
            label={t("staff.employeeNumber")}
            value={employeeId}
            options={employeeOptions}
            disabled={busy}
            onChange={(event) => setEmployeeId(event.currentTarget.value)}
          />
          <TextField
            label={t("staff.email")}
            type="email"
            value={email}
            required
            disabled={busy}
            onChange={(event) => setEmail(event.currentTarget.value)}
          />
          <TextField
            label={t("staff.displayName")}
            value={displayName}
            required
            disabled={busy}
            onChange={(event) => setDisplayName(event.currentTarget.value)}
          />
        </>
      ) : null}
      {!cashier?.revokedAt ? (
        <>
          <TextField
            ref={pinRef}
            label={t("staff.pin")}
            type="password"
            inputMode="numeric"
            pattern="[0-9]{4,12}"
            minLength={4}
            maxLength={12}
            autoComplete="new-password"
            value={pin}
            required
            disabled={busy}
            onChange={(event) => setPin(event.currentTarget.value)}
            onBlur={() => setPin("")}
            onCopy={(event) => event.preventDefault()}
            onCut={(event) => event.preventDefault()}
          />
          <Button
            type="submit"
            disabled={busy}
            onPointerDown={(event) => {
              if (document.activeElement === pinRef.current) event.preventDefault();
            }}
          >
            {t(cashier ? "staff.resetPin" : "staff.createCashier")}
          </Button>
        </>
      ) : null}
      {cashier && !cashier.revokedAt && !confirmRevoke ? (
        <Button
          ref={revokeRef}
          type="button"
          variant="danger"
          disabled={busy}
          onClick={() => askRevoke(true)}
        >
          {t("staff.revoke")}
        </Button>
      ) : null}
      {cashier && !cashier.revokedAt && confirmRevoke ? (
        // UI-19: revoking locks this cashier out of every till and the screen offers no way back, so it is asked.
        <div
          role="alertdialog"
          aria-labelledby={`revoke-${cashier.principalId}`}
          className="flex flex-col gap-2"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              // Answer the question only; the panel's own Esc stays for when no question is open.
              event.stopPropagation();
              event.preventDefault();
              askRevoke(false);
            }
          }}
        >
          <p id={`revoke-${cashier.principalId}`}>
            <bdi>{t("staff.revokeQuestion", { cashier: cashierLabel })}</bdi>
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="danger"
              disabled={busy}
              onClick={() => {
                void revoke();
              }}
            >
              {t("staff.revokeConfirm")}
            </Button>
            <Button
              ref={cancelRevokeRef}
              type="button"
              disabled={busy}
              onClick={() => askRevoke(false)}
            >
              {t("staff.revokeCancel")}
            </Button>
          </div>
        </div>
      ) : null}
      <Button type="button" onClick={onClose}>
        {t("staff.close")}
      </Button>
      {failure ? <StaffFailure cause={failure} /> : null}
      {!cashier ? <p>{t("staff.assignRoleHint")}</p> : null}
    </form>
  );
}
