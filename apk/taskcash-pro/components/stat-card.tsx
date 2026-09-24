import * as React from "react";
import { cn } from "@/lib/format";

export function StatCard({
  label,
  value,
  hint,
  tone = "default",
  icon,
  className,
}: {
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
  /** `positive` paints the value green, `accent` orange, `brand` blue. */
  tone?: "default" | "positive" | "accent" | "brand";
  icon?: React.ReactNode;
  className?: string;
}) {
  const valueTone =
    tone === "positive"
      ? "text-cash"
      : tone === "accent"
        ? "text-flame-400"
        : tone === "brand"
          ? "text-brand-400"
          : "text-white";

  return (
    <div className={cn("tc-card-alt p-3.5 sm:p-4", className)}>
      <div className="flex items-center justify-between gap-2">
        <span className="tc-label">{label}</span>
        {icon ? <span className="text-muted [&>svg]:h-3.5 [&>svg]:w-3.5">{icon}</span> : null}
      </div>
      <p className={cn("tc-value mt-1.5 text-lg sm:text-xl", valueTone)}>{value}</p>
      {hint ? <p className="mt-1 text-[11px] leading-snug text-muted">{hint}</p> : null}
    </div>
  );
}
