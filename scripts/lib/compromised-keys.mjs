import { createHash } from "node:crypto";

/**
 * Secret keys known to have been exposed in plain text.
 *
 * A secret key bypasses Row Level Security, so once it has been pasted into a
 * chat, a ticket, a screenshot or a log line it must be treated as public. A
 * note in a README saying "remember to rotate" does not survive a busy week —
 * this list is checked on every `npm run preflight`, which makes the exposed
 * key fail loudly until it is actually replaced.
 *
 * Only a SHA-256 *fingerprint* is stored, never the key. A fingerprint cannot
 * be reversed into the key, so this file is safe to commit and safe to read.
 *
 * Removing a fingerprint is NOT the way to silence this check. Rotate the key:
 * the check stops firing on its own once the configured value no longer
 * matches, because a replacement key hashes to something else entirely.
 */
export const COMPROMISED_KEY_FINGERPRINTS = [
  {
    fingerprint: "499ae878a74a",
    // The value was pasted into a development conversation in full.
    note: "exposed in plain text during setup",
  },
  {
    fingerprint: "6e1b1434d0ae",
    // Offered as the REPLACEMENT for the key above, and pasted into the same
    // conversation rather than entered through the masked `npm run env:set`
    // prompt. It is a valid key; it is simply no longer a secret. Rotating
    // again is the only fix — and entering it through `env:set` is what stops
    // this repeating, because that prompt is masked and writes only to
    // .env.local.
    note: "exposed in plain text during setup (as its own replacement)",
  },
];

/** A stable, non-reversible identifier for a key value. */
export function keyFingerprint(value) {
  if (!value) return null;
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

/** The recorded compromise matching this value, or null. */
export function compromisedMatch(value) {
  const fingerprint = keyFingerprint(value);
  if (!fingerprint) return null;
  return (
    COMPROMISED_KEY_FINGERPRINTS.find((entry) => entry.fingerprint === fingerprint) ?? null
  );
}
