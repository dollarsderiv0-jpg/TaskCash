import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import type { TransactionKind, TransactionStatus } from "./types";

/** Tailwind-aware class merge, so conditional classes can't both win. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Grouping is done by hand rather than with `toLocaleString`: the server and the
 * browser can resolve different default locales, and a comma appearing in only
 * one of them is a hydration mismatch.
 */
function groupThousands(value: string): string {
  const negative = value.startsWith("-");
  const digits = negative ? value.slice(1) : value;
  const [whole, fraction] = digits.split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}${grouped}${fraction ? `.${fraction}` : ""}`;
}

export function formatNumber(amount: number, decimals = 0): string {
  const safe = Number.isFinite(amount) ? amount : 0;
  return groupThousands(safe.toFixed(decimals));
}

/** `KES 1,008` / `KES 18.00` — the currency prefix is part of the string so it
 *  never wraps away from its figure. */
export function formatMoney(amount: number, decimals = 2): string {
  return `KES ${formatNumber(amount, decimals)}`;
}

/** Compact form for table rows and badges: `KES 70,000`. */
export function formatMoneyCompact(amount: number): string {
  return formatMoney(amount, 0);
}

/** Signed form for ledger rows: `+KES 150`, `-KES 500`. */
export function formatSigned(amount: number, kind: TransactionKind): string {
  return `${isCredit(kind) ? "+" : "-"}${formatMoney(amount, 2)}`;
}

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

const pad = (n: number) => String(n).padStart(2, "0");

/** `23 Sep 2026, 09:12` — locale-independent, built from UTC parts. */
export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/** `23 Sep 2026` */
export function formatDate(iso: string): string {
  return formatDateTime(iso).split(",")[0];
}

/** `3d 04h remaining` from a live millisecond gap. Never negative. */
export function formatCountdown(msRemaining: number): string {
  if (msRemaining <= 0) return "Expired";
  const totalMinutes = Math.floor(msRemaining / 60_000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${pad(hours)}h remaining`;
  if (hours > 0) return `${hours}h ${pad(minutes)}m remaining`;
  return `${minutes}m remaining`;
}

/** `mm:ss` for the task countdown. */
export function formatClock(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  return `${pad(Math.floor(safe / 60))}:${pad(safe % 60)}`;
}

/** `18s remaining` style copy used under the task progress bar. */
export function formatSecondsRemaining(totalSeconds: number): string {
  return `${Math.max(0, Math.ceil(totalSeconds))}s remaining`;
}

/** True when money comes *in* for this kind of entry. */
export function isCredit(kind: TransactionKind): boolean {
  return kind === "task_reward" || kind === "deposit" || kind === "bonus";
}

export const TRANSACTION_LABELS: Record<TransactionKind, string> = {
  task_reward: "Task reward",
  package_activation: "Package activation",
  deposit: "Deposit",
  withdrawal: "Withdrawal",
  bonus: "Bonus",
};

export const STATUS_LABELS: Record<TransactionStatus, string> = {
  completed: "Completed",
  pending: "Pending",
  failed: "Failed",
};
