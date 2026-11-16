import clsx from "clsx";
import { forwardRef, useId, type InputHTMLAttributes } from "react";

export interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "id"> {
  /** Already translated by the caller — `packages/ui` never calls `t` (§3.1). */
  label: string;
  hint?: string;
  error?: string;
}

/**
 * `forwardRef` so a screen can move focus into the field from outside it — the users-and-roles
 * screen's `/` shortcut (spec:2254 "keyboard shortcuts, no mouse required") needs the `<input>`
 * itself, not the wrapper this component renders around it.
 */
export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(function TextField(
  { label, hint, error, className, ...rest },
  ref,
) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-start text-text">
        {label}
      </label>
      <input
        id={id}
        ref={ref}
        aria-invalid={error ? true : undefined}
        aria-describedby={clsx(hint && hintId, error && errorId) || undefined}
        className={clsx(
          "rounded-sm border border-border bg-surface px-3 py-2 text-start text-text",
          error && "border-danger",
          className,
        )}
        {...rest}
      />
      {hint ? (
        <p id={hintId} className="text-start text-text-muted">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} role="alert" className="text-start text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
});
