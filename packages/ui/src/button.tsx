import clsx from "clsx";
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "danger";
  children: ReactNode;
}

const VARIANTS = {
  primary: "bg-accent text-accent-text border-accent",
  secondary: "bg-surface text-text border-border",
  danger: "bg-danger text-danger-text border-danger",
} as const;

/**
 * `forwardRef` for the same reason `TextField` has one: a screen that moves focus deliberately needs
 * the `<button>` itself. The users screen restores focus after a submit only when focus is still
 * where the press left it — on this element, or on `<body>` once the browser has blurred it for
 * being disabled — and it cannot ask that question without the node.
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", className, type = "button", ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={clsx(
        "inline-flex items-center gap-2 rounded-sm border px-4 py-2 text-start disabled:opacity-60",
        VARIANTS[variant],
        className,
      )}
      {...rest}
    />
  );
});
