/**
 * Durations, said the way a person would say them.
 *
 * A limit that lasts an hour must not announce itself as "a moment". Saying so
 * is not a rounding error: it teaches the caller to retry immediately, and
 * every retry pushes a fixed-window counter further out, so guessing keeps a
 * user blocked for as long as they keep guessing.
 */
export function humanWait(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "a moment";
  if (seconds === 1) return "a second";
  if (seconds < 60) return `${Math.floor(seconds)} seconds`;

  const minutes = Math.ceil(seconds / 60);
  if (minutes === 1) return "about a minute";
  if (minutes < 60) return `about ${minutes} minutes`;

  const hours = Math.max(1, Math.round(minutes / 60));
  return hours === 1 ? "about an hour" : `about ${hours} hours`;
}

/** `m:ss`, for a live countdown. */
export function formatCountdown(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(safe / 60);
  return `${minutes}:${String(safe % 60).padStart(2, "0")}`;
}
