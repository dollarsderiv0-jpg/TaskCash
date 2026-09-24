import { cn } from "@/lib/format";

export type BadgeTone = "active" | "inactive" | "pending" | "failed" | "brand" | "neutral";

const TONES: Record<BadgeTone, string> = {
  active: "border-cash/45 bg-cash/12 text-cash",
  inactive: "border-hairline bg-white/[0.03] text-muted",
  pending: "border-flame/45 bg-flame/12 text-flame-400",
  failed: "border-flame/45 bg-flame/12 text-flame-400",
  brand: "border-brand/50 bg-brand/15 text-brand-400",
  neutral: "border-hairline bg-white/[0.03] text-white/80",
};

export function StatusBadge({
  tone = "neutral",
  children,
  className,
  dot = false,
}: {
  tone?: BadgeTone;
  children: React.ReactNode;
  className?: string;
  dot?: boolean;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-bold uppercase tracking-[0.1em]",
        TONES[tone],
        className,
      )}
    >
      {dot ? <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden /> : null}
      {children}
    </span>
  );
}
