import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { LucideIcon } from "lucide-react";

export function StatCard({
  label,
  value,
  hint,
  icon: Icon,
  tone = "default",
  className,
}: {
  label: string;
  value: string;
  hint?: string;
  icon?: LucideIcon;
  tone?: "default" | "success" | "warning" | "muted";
  className?: string;
}) {
  const toneStyles = {
    default: "text-foreground",
    success: "text-emeraldBrand-600 dark:text-emeraldBrand-400",
    warning: "text-amber-600 dark:text-amber-400",
    muted: "text-muted-foreground",
  } as const;

  return (
    <Card className={cn("transition-shadow hover:shadow-md", className)}>
      <CardContent className="flex items-start justify-between gap-3 p-4">
        <div className="min-w-0">
          <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
          <p className={cn("mt-1.5 truncate text-lg font-bold tracking-tight", toneStyles[tone])}>
            {value}
          </p>
          {hint ? <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p> : null}
        </div>
        {Icon ? (
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-secondary">
            <Icon className="h-4 w-4 text-muted-foreground" aria-hidden />
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
