import * as React from "react";
import { cn } from "@/lib/format";

type Variant = "flame" | "brand" | "outline" | "ghost" | "danger";
type Size = "sm" | "md" | "lg";

const VARIANTS: Record<Variant, string> = {
  /* The one call to action that earns money. Orange, gradient, glowing. */
  flame:
    "bg-gradient-to-b from-flame-400 to-flame text-white shadow-flame hover:brightness-110 active:brightness-95",
  /* Navigation and confirmed-but-not-earning actions. Blue, flat. */
  brand:
    "bg-brand text-white shadow-brand hover:bg-brand-400 active:bg-brand-600",
  outline:
    "border border-hairline bg-transparent text-white hover:border-flame/60 hover:bg-white/[0.04]",
  ghost: "bg-white/[0.04] text-white hover:bg-white/[0.08]",
  danger: "bg-transparent text-flame-400 hover:bg-flame/10",
};

const SIZES: Record<Size, string> = {
  sm: "h-9 px-3.5 text-[13px]",
  md: "h-11 px-4 text-sm",
  lg: "h-12 px-5 text-[15px]",
};

/** Shared class recipe so a `next/link` can be styled identically to a button. */
export function buttonStyles({
  variant = "flame",
  size = "md",
  full = false,
  className,
}: {
  variant?: Variant;
  size?: Size;
  full?: boolean;
  className?: string;
} = {}) {
  return cn(
    "inline-flex select-none items-center justify-center gap-2 rounded-tile font-semibold transition",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-flame/70 focus-visible:ring-offset-2 focus-visible:ring-offset-surface",
    "disabled:cursor-not-allowed disabled:opacity-45 disabled:shadow-none disabled:hover:brightness-100",
    VARIANTS[variant],
    SIZES[size],
    full && "w-full",
    className,
  );
}

export interface PrimaryButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  full?: boolean;
  loading?: boolean;
}

export function PrimaryButton({
  variant = "flame",
  size = "md",
  full = false,
  loading = false,
  className,
  children,
  disabled,
  ...props
}: PrimaryButtonProps) {
  return (
    <button
      className={buttonStyles({ variant, size, full, className })}
      disabled={disabled || loading}
      {...props}
    >
      {loading ? (
        <span
          aria-hidden
          className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent"
        />
      ) : null}
      {children}
    </button>
  );
}
