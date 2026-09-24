import Link from "next/link";
import { cn } from "@/lib/format";

export function Brand({
  className,
  href = "/dashboard",
}: {
  className?: string;
  href?: string;
}) {
  return (
    <Link
      href={href}
      className={cn(
        "text-[15px] font-extrabold uppercase tracking-[0.14em] transition hover:opacity-90",
        className,
      )}
    >
      <span className="text-white">TaskCash</span>{" "}
      <span className="bg-gradient-to-b from-flame-400 to-flame bg-clip-text text-transparent">
        Pro
      </span>
    </Link>
  );
}
