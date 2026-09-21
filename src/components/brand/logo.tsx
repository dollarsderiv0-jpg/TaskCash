import { cn } from "@/lib/utils";

/**
 * Brand marks.
 *
 * The icon is a "TC" monogram inside a rounded signal shape, echoed by a small
 * upward accent that reads as growth without implying guaranteed returns.
 */
export function LogoMark({ className, ...props }: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 40 40"
      role="img"
      aria-label="TaskCash Pro"
      className={cn("h-9 w-9", className)}
      {...props}
    >
      <defs>
        <linearGradient id="tc-mark-bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#0e1a33" />
          <stop offset="100%" stopColor="#b33d09" />
        </linearGradient>
      </defs>
      <rect x="0" y="0" width="40" height="40" rx="12" fill="url(#tc-mark-bg)" />
      {/* T */}
      <path
        d="M9 13.5h9.5"
        stroke="#ffffff"
        strokeWidth="2.6"
        strokeLinecap="round"
      />
      <path d="M13.75 13.5V27" stroke="#ffffff" strokeWidth="2.6" strokeLinecap="round" />
      {/* C */}
      <path
        d="M31.5 15.2a7.4 7.4 0 1 0 0 9.6"
        stroke="#f8833b"
        strokeWidth="2.6"
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  );
}

export function Logo({
  className,
  showTagline = false,
  size = "md",
}: {
  className?: string;
  showTagline?: boolean;
  size?: "sm" | "md" | "lg";
}) {
  const markSize = size === "sm" ? "h-7 w-7" : size === "lg" ? "h-11 w-11" : "h-9 w-9";
  const textSize =
    size === "sm" ? "text-sm" : size === "lg" ? "text-xl" : "text-base";

  return (
    <span className={cn("flex items-center gap-2.5", className)}>
      <LogoMark className={markSize} aria-hidden />
      <span className="flex flex-col leading-none">
        <span className={cn("font-bold tracking-tight", textSize)}>
          TASKCASH<span className="tc-gradient-text"> PRO</span>
        </span>
        {showTagline ? (
          <span className="mt-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
            Watch. Complete. Earn.
          </span>
        ) : null}
      </span>
    </span>
  );
}
