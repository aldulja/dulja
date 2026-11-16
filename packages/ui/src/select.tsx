import clsx from "clsx";
import { useId, type SelectHTMLAttributes } from "react";

export interface SelectOption {
  value: string;
  /** Already translated by the caller. */
  label: string;
}

export interface SelectProps extends Omit<
  SelectHTMLAttributes<HTMLSelectElement>,
  "id" | "children"
> {
  label: string;
  options: readonly SelectOption[];
}

export function Select({ label, options, className, ...rest }: SelectProps) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-start text-text">
        {label}
      </label>
      <select
        id={id}
        className={clsx(
          "rounded-sm border border-border bg-surface px-3 py-2 text-start text-text",
          className,
        )}
        {...rest}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}
