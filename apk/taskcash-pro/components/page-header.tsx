import * as React from "react";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { cn } from "@/lib/format";

export function PageHeader({
  title,
  subtitle,
  backHref,
  actions,
  className,
}: {
  title: string;
  subtitle?: React.ReactNode;
  backHref?: string;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("mb-4 flex flex-wrap items-end justify-between gap-3", className)}>
      <div className="min-w-0">
        {backHref ? (
          <Link
            href={backHref}
            className="mb-1.5 inline-flex items-center gap-1 text-xs font-semibold text-muted transition hover:text-white"
          >
            <ChevronLeft className="h-3.5 w-3.5" aria-hidden />
            Back
          </Link>
        ) : null}
        <h1 className="text-xl font-extrabold tracking-tight text-white sm:text-2xl">{title}</h1>
        {subtitle ? <p className="mt-1 text-[13px] leading-snug text-muted">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </div>
  );
}
