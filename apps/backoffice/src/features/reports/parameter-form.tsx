import { CATALOGUES, formatDate, type TranslationKey } from "@dulja/i18n";
import { Select, TextField } from "@dulja/ui";
import { useQueries } from "@tanstack/react-query";
import { useId, type ReactNode } from "react";
import { useI18n } from "../../lib/i18n-provider";
import type { LookupKind, LookupOption, ReportApi } from "../../lib/report-api";
import { localName } from "./shared";

/** §4.11.1's parameter declaration, as the definition document carries it. */
export interface ReportParameter {
  name: string;
  kind:
    | "date"
    | "date_range"
    | "period"
    | "account"
    | "party"
    | "item"
    | "warehouse"
    | "branch"
    | "dimension_value"
    | "enum"
    | "text";
  required: boolean;
  options?: string[];
}

const LOOKUP_KINDS: ReadonlySet<string> = new Set<LookupKind>([
  "period",
  "account",
  "party",
  "item",
  "warehouse",
  "branch",
]);
const isLookup = (kind: string): kind is LookupKind => LOOKUP_KINDS.has(kind);

/** A catalogue key, if the catalogue has one — `en` is the key registry both catalogues are held to. */
const knownKey = (key: string): TranslationKey | null =>
  Object.hasOwn(CATALOGUES.en, key) ? (key as TranslationKey) : null;

/** Reads the parameters out of a stored definition, keeping only well-formed entries. */
export function parametersOf(definition: Record<string, unknown>): ReportParameter[] {
  const raw = definition["parameters"];
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (p): p is ReportParameter =>
      typeof p === "object" &&
      p !== null &&
      typeof (p as { name?: unknown }).name === "string" &&
      typeof (p as { kind?: unknown }).kind === "string",
  );
}

/**
 * The values a fresh form starts from: every parameter empty, except a REQUIRED enum, which starts on its first
 * option — the declaration lists the one an operator means by default first (`hideQuantity: "0"`,
 * `isMatched: "false"`), and an empty required enum could only ever be refused.
 */
export function initialValues(parameters: readonly ReportParameter[]): Record<string, string> {
  return Object.fromEntries(
    parameters.map((p) => [
      p.name,
      p.kind === "enum" && p.required && p.options?.[0] !== undefined ? p.options[0] : "",
    ]),
  );
}

/** The run body's `parameters`: empty values are omitted, never sent as `""` (the API reads "" as missing). */
export function filledValues(values: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== ""));
}

/**
 * The parameter form, generated from the definition's `parameters` by kind (7A T15): a date is a date field, an
 * enum a dropdown of its declared options, a reference kind a dropdown read from the list route that serves that
 * master, and anything else a text field. A reference list the operator may not read — each list route is gated on
 * its own code — falls back to a typed id, so a refusal there never hides a parameter the report needs. A list is
 * read page by page to its end; one that stops at `LOOKUP_MAX_PAGES` keeps its dropdown and adds a typed-id field
 * beside it, so no record is out of reach (7 review).
 */
export function ParameterForm({
  client,
  code,
  parameters,
  values,
  onChange,
  errors,
  disabled,
  scope,
}: {
  client: ReportApi;
  /** The report code, for a label one definition gives a shared parameter name (8D T10: `hr.attendance`'s `kind`
   *  is an attendance event kind, not 6B's promotion kind). */
  code?: string;
  parameters: readonly ReportParameter[];
  values: Readonly<Record<string, string>>;
  onChange: (name: string, value: string) => void;
  errors: ReadonlyMap<string, string>;
  disabled: boolean;
  /** The company and session the lookups are cached under, so a switch never reuses another's lists. */
  scope: readonly unknown[];
}) {
  const { t, locale } = useI18n();
  const kinds = [...new Set(parameters.map((p) => p.kind).filter(isLookup))];
  const lookups = useQueries({
    queries: kinds.map((kind) => ({
      queryKey: ["report-lookup", ...scope, kind],
      queryFn: ({ signal }: { signal: AbortSignal }) => client.lookup(kind, { signal }),
      retry: false,
      staleTime: 60_000,
    })),
  });
  const lookupFor = (kind: LookupKind) => lookups[kinds.indexOf(kind)];
  const optionLabel = (option: LookupOption): string =>
    option.period
      ? `${formatDate(option.period.startsOn, { locale })} – ${formatDate(option.period.endsOn, { locale })}`
      : `${option.code} — ${localName(option, locale)}`;
  /**
   * A definition names its parameters but carries no label for them (§4.11.1), so the catalogue holds one per
   * name the shipped definitions use; a name it does not know is shown as the name and its kind.
   */
  const paramLabel = (p: ReportParameter): string => {
    const named =
      (code === undefined ? null : knownKey(`report.param.for.${code}.${p.name}`)) ??
      knownKey(`report.param.name.${p.name}`);
    const kind = t(`report.param.kind.${p.kind}` as TranslationKey);
    const text = named ? t(named) : t("report.param.unnamed", { name: p.name, kind });
    return p.required ? t("report.param.required", { label: text }) : text;
  };
  const optionText = (value: string): string => {
    const named = knownKey(`report.param.option.${value}`);
    return named ? t(named) : value;
  };

  if (parameters.length === 0)
    return <p className="text-start text-text-muted">{t("report.param.none")}</p>;
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {parameters.map((p) => {
        const error = errors.get(`/parameters/${p.name}`);
        const label = paramLabel(p);
        const common = { value: values[p.name] ?? "", disabled };
        if (p.kind === "enum") {
          return (
            <FieldWithError key={p.name} error={error}>
              {(describedBy) => (
                <Select
                  label={label}
                  {...common}
                  aria-describedby={describedBy}
                  aria-invalid={error ? true : undefined}
                  required={p.required}
                  options={[
                    ...(p.required ? [] : [{ value: "", label: t("report.param.any") }]),
                    ...(p.options ?? []).map((value) => ({ value, label: optionText(value) })),
                  ]}
                  onChange={(event) => onChange(p.name, event.currentTarget.value)}
                />
              )}
            </FieldWithError>
          );
        }
        if (isLookup(p.kind)) {
          const lookup = lookupFor(p.kind);
          // While the list loads the dropdown is already there, holding one "Loading…" choice, so the cursor
          // the screen put in it stays in it when the choices arrive.
          if (lookup?.isSuccess || lookup?.isPending) {
            const loaded = lookup.data?.options ?? [];
            // A list that stopped at its page cap also takes a typed or pasted id (7 review); a value that is
            // not among the choices read is offered as its own choice, so the dropdown never claims "none".
            const partial = lookup.isSuccess && !lookup.data.complete;
            const typed =
              partial && common.value !== "" && !loaded.some((o) => o.id === common.value);
            return (
              <div key={p.name} className="flex flex-col gap-2">
                <FieldWithError error={error}>
                  {(describedBy) => (
                    <Select
                      label={label}
                      {...common}
                      aria-describedby={describedBy}
                      aria-invalid={error ? true : undefined}
                      required={p.required}
                      aria-busy={lookup.isPending}
                      options={
                        lookup.isPending
                          ? [{ value: "", label: t("app.loading") }]
                          : [
                              {
                                value: "",
                                label: p.required
                                  ? t("report.param.choose")
                                  : t("report.param.any"),
                              },
                              ...loaded.map((option) => ({
                                value: option.id,
                                label: optionLabel(option),
                              })),
                              ...(typed ? [{ value: common.value, label: common.value }] : []),
                            ]
                      }
                      onChange={(event) => onChange(p.name, event.currentTarget.value)}
                    />
                  )}
                </FieldWithError>
                {partial ? (
                  <TextField
                    label={t("report.param.typedId", { label })}
                    value={common.value}
                    disabled={disabled}
                    dir="ltr"
                    hint={t("report.param.listTruncated", { count: String(loaded.length) })}
                    onChange={(event) => onChange(p.name, event.currentTarget.value.trim())}
                  />
                ) : null}
              </div>
            );
          }
        }
        return (
          <TextField
            key={p.name}
            label={label}
            {...common}
            type={p.kind === "date" ? "date" : "text"}
            {...(isLookup(p.kind) || p.kind === "dimension_value"
              ? { dir: "ltr", hint: t("report.param.idHint") }
              : {})}
            required={p.required}
            {...(error === undefined ? {} : { error })}
            onChange={(event) => onChange(p.name, event.currentTarget.value)}
          />
        );
      })}
    </div>
  );
}

/** `Select` has no error slot, so its message is rendered here and joined to the control by id. */
function FieldWithError({
  error,
  children,
}: {
  error: string | undefined;
  children: (describedBy: string | undefined) => ReactNode;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      {children(error === undefined ? undefined : id)}
      {error === undefined ? null : (
        <p id={id} role="alert" className="text-start text-danger">
          <bdi>{error}</bdi>
        </p>
      )}
    </div>
  );
}
