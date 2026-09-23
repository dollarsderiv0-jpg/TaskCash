/**
 * Money formatting and rounding.
 *
 * Amounts are stored as numeric(20,4) in Postgres. All arithmetic in the app
 * works on integer minor units to avoid float drift.
 */

const SYMBOLS: Record<string, string> = {
  KES: "KES",
  UGX: "UGX",
  TZS: "TZS",
  RWF: "RWF",
  NGN: "NGN",
  GHS: "GHS",
  ZAR: "ZAR",
  USD: "$",
  EUR: "€",
};

const MINOR_UNITS: Record<string, number> = {
  KES: 2,
  UGX: 0,
  TZS: 0,
  RWF: 0,
  NGN: 2,
  GHS: 2,
  ZAR: 2,
  USD: 2,
  EUR: 2,
};

export function minorUnits(currency: string): number {
  return MINOR_UNITS[currency.toUpperCase()] ?? 2;
}

export function toMinor(amount: number, currency: string): number {
  const factor = 10 ** minorUnits(currency);
  return Math.round(amount * factor);
}

export function fromMinor(minor: number, currency: string): number {
  const factor = 10 ** minorUnits(currency);
  return minor / factor;
}

/** Rounds an amount to the currency's smallest payable unit. */
export function roundMoney(amount: number, currency: string): number {
  return fromMinor(toMinor(amount, currency), currency);
}

/**
 * Rounds to two decimal places, whatever the currency.
 *
 * Deliberately NOT `roundMoney`: that rounds to the currency's own minor unit,
 * which is 0 for UGX/TZS/RWF. This mirrors `round(x, 2)` on a `numeric` in
 * Postgres, which is what the database uses when it computes a percentage fee.
 * Using the currency's precision here instead would make a preview disagree with
 * the charge it is previewing.
 */
export function roundToCents(amount: number): number {
  if (!Number.isFinite(amount)) return 0;
  return Math.round(amount * 100) / 100;
}

export function formatMoney(
  amount: number | string | null | undefined,
  currency = "KES",
  options: { compact?: boolean; withSymbol?: boolean; decimals?: number } = {},
): string {
  const numeric = typeof amount === "string" ? Number(amount) : (amount ?? 0);
  const safe = Number.isFinite(numeric) ? numeric : 0;
  /*
    `decimals` overrides the currency's own precision for DISPLAY ONLY — the
    value itself is untouched. The activity popup asks for whole units, where
    "KES 70,000" reads as somebody's deposit and "KES 70,000.00" reads as a
    statement line.
  */
  const decimals = options.decimals ?? minorUnits(currency);

  const formatted = new Intl.NumberFormat("en-KE", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
    notation: options.compact ? "compact" : "standard",
  }).format(safe);

  if (options.withSymbol === false) return formatted;
  const symbol = SYMBOLS[currency.toUpperCase()] ?? currency.toUpperCase();
  return `${symbol} ${formatted}`;
}

/** Compact chart-friendly form, e.g. "KES 12.4K". */
export function formatMoneyShort(amount: number, currency = "KES"): string {
  const symbol = SYMBOLS[currency.toUpperCase()] ?? currency.toUpperCase();
  const formatted = new Intl.NumberFormat("en-KE", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(Number.isFinite(amount) ? amount : 0);
  return `${symbol} ${formatted}`;
}

export function formatSignedMoney(amount: number, currency = "KES"): string {
  const sign = amount > 0 ? "+" : amount < 0 ? "−" : "";
  return `${sign}${formatMoney(Math.abs(amount), currency)}`;
}

export function formatDate(value: string | Date | null | undefined): string {
  if (!value) return "—";
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("en-KE", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(date);
}

export function formatDateTime(value: string | Date | null | undefined): string {
  if (!value) return "—";
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("en-KE", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function relativeTime(value: string | Date | null | undefined): string {
  if (!value) return "—";
  const date = typeof value === "string" ? new Date(value) : value;
  const diffMs = Date.now() - date.getTime();
  const seconds = Math.round(diffMs / 1000);
  if (Math.abs(seconds) < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (Math.abs(days) < 30) return `${days}d ago`;
  return formatDate(date);
}

/**
 * The same elapsed time, spelled out: "1 min ago", "5 mins ago", "2 hours ago".
 *
 * `relativeTime` above stays compact ("5m ago"), which is right in a table cell
 * squeezed against a timestamp column. A sentence needs the words.
 *
 * Elapsed time is TRUNCATED, never rounded: 119 seconds is "1 min ago", because
 * rounding up would claim more time has passed than actually has. A completion
 * time in the future — clock skew between the database and the browser —
 * degrades to "just now" rather than to a negative count.
 */
export function relativeTimeWords(value: string | Date | null | undefined): string {
  if (!value) return "—";
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return "—";

  const seconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
  if (seconds < 60) return "just now";

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min${minutes === 1 ? "" : "s"} ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;

  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? "" : "s"} ago`;

  return formatDate(date);
}
