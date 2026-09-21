#!/usr/bin/env node
/**
 * Preflight: is this deployment actually configured?
 *
 *   npm run preflight
 *
 * Reads .env.local (and the real environment), then reports every required
 * variable by NAME only. Values are never printed — not in the report, not in
 * a failure reason, never.
 *
 * Output is grouped the way the failures actually behave:
 *
 *   PUBLIC CONFIGURATION        shipped to the browser; breaks rendering
 *   SERVER SECRET CONFIGURATION server-only; without it there is no auth or money
 *   DATABASE CONFIGURATION      used by the migration scripts, not by the running app
 *
 * Exits non-zero when the application cannot run, so it is safe as a gate
 * (`npm run backend:setup` stops on it).
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compromisedMatch } from "./lib/compromised-keys.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/* -------------------------------------------------------------------------- */
/* Environment                                                                */
/* -------------------------------------------------------------------------- */

function loadEnvLocal() {
  const file = join(ROOT, ".env.local");
  if (!existsSync(file)) return false;
  for (const rawLine of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
  return true;
}

const hasEnvLocal = loadEnvLocal();

function env(key) {
  const value = process.env[key];
  return value && value.trim() !== "" ? value.trim() : null;
}

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/* Check harness                                                              */
/* -------------------------------------------------------------------------- */

const CATEGORIES = {
  public: "PUBLIC CONFIGURATION (shipped to the browser)",
  server: "SERVER SECRET CONFIGURATION (never leaves the server)",
  database: "DATABASE CONFIGURATION (migration workflow)",
  email: "EMAIL DELIVERY (Supabase Auth SMTP)",
  payments: "PAYMENTS (mobile money provider)",
  hygiene: "SECRET HYGIENE",
};

const checks = [];

/**
 * @param {"pass"|"fail"} status
 * @param {string} category
 * @param {string} name    variable name (never a value)
 * @param {string} reason  what was found
 * @param {string} [fix]   how to fix it — required when status is "fail"
 */
function record(status, category, name, reason, fix) {
  checks.push({ status, category, name, reason, fix });
}

function pass(category, name, reason) {
  record("pass", category, name, reason);
}

function fail(category, name, reason, fix) {
  record("fail", category, name, reason, fix);
}

/* -------------------------------------------------------------------------- */
/* Public configuration                                                       */
/* -------------------------------------------------------------------------- */

const supabaseUrl = env("NEXT_PUBLIC_SUPABASE_URL");

// The project ref lets us link straight to the page holding a missing value,
// instead of describing where it lives.
const projectRef = (() => {
  try {
    const host = new URL(supabaseUrl ?? "").hostname;
    return host.endsWith(".supabase.co") ? host.split(".")[0] : null;
  } catch {
    return null;
  }
})();
const dash = (page) =>
  projectRef
    ? `https://supabase.com/dashboard/project/${projectRef}/${page}`
    : "Supabase dashboard → your project →";

if (!supabaseUrl) {
  fail(
    "public",
    "NEXT_PUBLIC_SUPABASE_URL",
    "not set",
    `${dash("settings/api")} → Project URL. Set it with: npm run env:set`,
  );
} else if (!isHttpUrl(supabaseUrl)) {
  fail("public", "NEXT_PUBLIC_SUPABASE_URL", "not a valid http(s) URL", "Copy the Project URL verbatim from the dashboard.");
} else {
  pass("public", "NEXT_PUBLIC_SUPABASE_URL", `set${projectRef ? ` (project ${projectRef})` : ""}`);
}

const publishable = env("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY");
if (!publishable) {
  fail(
    "public",
    "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
    "not set",
    `${dash("settings/api-keys")} → publishable key (sb_publishable_…)`,
  );
} else if (publishable.length < 20) {
  fail("public", "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "too short to be a key", "Copy the full key; a partial paste is the usual cause.");
} else if (publishable.startsWith("sb_secret_")) {
  // The mirror image of the mistake below, and just as bad: a secret key in a
  // NEXT_PUBLIC_ variable is embedded into browser JavaScript.
  fail(
    "public",
    "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
    "this is a SECRET key, not the publishable key",
    "Move it to SUPABASE_SECRET_KEY (no NEXT_PUBLIC_ prefix) and put the sb_publishable_… key here. Rotate the secret key: it was about to be shipped to browsers.",
  );
} else {
  pass("public", "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", `set (${publishable.length} chars)`);
}

/* -------------------------------------------------------------------------- */
/* Server secret configuration                                                */
/* -------------------------------------------------------------------------- */

const secretKey = env("SUPABASE_SECRET_KEY");
const legacyKey = env("SUPABASE_SERVICE_ROLE_KEY");

if (!secretKey && !legacyKey) {
  fail(
    "server",
    "SUPABASE_SECRET_KEY",
    "not set",
    [
      `${dash("settings/api-keys")} → "Publishable and secret API keys" → secret key (sb_secret_…)`,
      '  If that tab offers "Create new API keys", a secret key may not exist yet — create one (type: secret).',
      "  The legacy `service_role` key also works: set it as SUPABASE_SERVICE_ROLE_KEY instead.",
      "  Set it with: npm run env:set  (masked prompt; never commit it)",
    ].join("\n      "),
  );
} else if (secretKey && secretKey.startsWith("sb_publishable_")) {
  fail(
    "server",
    "SUPABASE_SECRET_KEY",
    "This is a publishable key. Use the Supabase Secret key instead.",
    `${dash("settings/api-keys")} → the secret key (sb_secret_…), not the publishable one. Fix with: npm run env:set`,
  );
} else if (secretKey && secretKey.length < 20) {
  fail("server", "SUPABASE_SECRET_KEY", "too short to be a key", "Copy the full key; a partial paste is the usual cause.");
} else if (compromisedMatch(secretKey ?? legacyKey)) {
  // Well-formed, and burned: a secret key that has been shared in plain text is
  // public. This is a single check per variable — the shape checks above have
  // already passed, so the key is reported once, as a failure.
  fail(
    "server",
    "SUPABASE_SECRET_KEY",
    `this key is known to be ${compromisedMatch(secretKey ?? legacyKey).note} and must be replaced`,
    [
      `${dash("settings/api-keys")} → create a NEW secret key, then: npm run env:set`,
      "  Then DELETE the old key in the dashboard — it keeps working for anyone who saw it until you do.",
      "  Do not edit scripts/lib/compromised-keys.mjs to silence this; only a replacement key fixes it.",
    ].join("\n      "),
  );
} else if (secretKey) {
  const legacyJwt = secretKey.startsWith("ey");
  pass(
    "server",
    "SUPABASE_SECRET_KEY",
    legacyJwt
      ? `set (${secretKey.length} chars, legacy JWT — a sb_secret_ key is preferred)`
      : `set (${secretKey.length} chars)`,
  );
} else {
  pass(
    "server",
    "SUPABASE_SECRET_KEY",
    `set by the legacy SUPABASE_SERVICE_ROLE_KEY (${legacyKey.length} chars) — prefer SUPABASE_SECRET_KEY`,
  );
}

const appUrl = env("APP_URL") ?? env("NEXT_PUBLIC_APP_URL");
if (!appUrl) {
  fail("server", "APP_URL", "not set", "Local development: http://localhost:4177 — production: your public https URL");
} else if (!isHttpUrl(appUrl)) {
  fail("server", "APP_URL", "not a valid http(s) URL", "It must include the scheme, e.g. http://localhost:4177");
} else {
  pass("server", "APP_URL", `set (${appUrl})`);
}

const authSecret = env("AUTH_SECRET");
if (!authSecret) {
  fail(
    "server",
    "AUTH_SECRET",
    "not set",
    'Generate one locally — do not take it from Supabase:\n      node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64url\'))"',
  );
} else if (authSecret.length < 32) {
  fail("server", "AUTH_SECRET", `too short (${authSecret.length} chars, minimum 32)`, "Generate a fresh 32-byte value with the command above.");
} else {
  pass("server", "AUTH_SECRET", `set (${authSecret.length} chars)`);
}

// Optional. Absence is not a fault; a malformed value is.
const jwksUrl = env("SUPABASE_JWKS_URL");
if (!jwksUrl) {
  pass("server", "SUPABASE_JWKS_URL", "not set (optional — only server-side JWT verification needs it)");
} else if (!isHttpUrl(jwksUrl)) {
  fail("server", "SUPABASE_JWKS_URL", "not a valid http(s) URL", "Expected https://<ref>.supabase.co/auth/v1/.well-known/jwks.json");
} else if (supabaseUrl && !jwksUrl.startsWith(supabaseUrl)) {
  fail("server", "SUPABASE_JWKS_URL", `points at a different project than NEXT_PUBLIC_SUPABASE_URL`, "Both must come from the same Supabase project, or issued tokens will never verify.");
} else {
  pass("server", "SUPABASE_JWKS_URL", "set (matches the configured project)");
}

/* -------------------------------------------------------------------------- */
/* Database configuration                                                     */
/* -------------------------------------------------------------------------- */

const databaseUrl = env("DATABASE_URL");

if (!databaseUrl) {
  fail(
    "database",
    "DATABASE_URL",
    "not set — migrations cannot be applied",
    [
      `${dash("settings/database")} → Connection string → Session pooler → URI`,
      "  Replace [YOUR-PASSWORD] with the database password. No password? Reset it on that page.",
      "  Port 5432 (session pooler). Set it with: npm run env:set",
    ].join("\n      "),
  );
} else if (databaseUrl.includes("[YOUR-PASSWORD]")) {
  fail(
    "database",
    "DATABASE_URL",
    "still contains the [YOUR-PASSWORD] placeholder",
    "Replace it with the real database password (and percent-encode reserved characters).",
  );
} else {
  let url = null;
  try {
    url = new URL(databaseUrl);
  } catch {
    /* handled below */
  }

  if (!url || !/^postgres(ql)?:$/.test(url.protocol)) {
    fail("database", "DATABASE_URL", "not a postgresql:// connection string", "Copy the URI from the dashboard rather than typing it.");
  } else if (!url.password) {
    fail("database", "DATABASE_URL", "has no password", "Insert the database password where [YOUR-PASSWORD] was.");
  } else if (url.port === "6543") {
    fail(
      "database",
      "DATABASE_URL",
      "uses port 6543 — the TRANSACTION pooler, which cannot run these migrations",
      "Use the Session pooler on port 5432 (or the direct connection) instead.",
    );
  } else if (hasBadPercentEncoding(url.password)) {
    fail(
      "database",
      "DATABASE_URL",
      "password contains a % that is not part of a %XX escape",
      "Percent-encode reserved characters in the password: % → %25, then @ : / ? # [ ] as %40 %3A %2F %3F %23 %5B %5D",
    );
  } else {
    pass("database", "DATABASE_URL", `set (host ${url.hostname.split(".")[0]}…:${url.port || "5432"})`);
  }
}

/**
 * A raw `%` in a password must start a valid two-digit escape, otherwise
 * drivers decode it differently and the failure looks like a bad password.
 */
function hasBadPercentEncoding(password) {
  for (let i = password.indexOf("%"); i !== -1; i = password.indexOf("%", i + 1)) {
    if (!/^[0-9A-Fa-f]{2}$/.test(password.slice(i + 1, i + 3))) return true;
  }
  return false;
}

/* -------------------------------------------------------------------------- */
/* Email delivery (Supabase Auth SMTP)                                        */
/* -------------------------------------------------------------------------- */

/**
 * SMTP is REQUIRED in production and merely reported in development.
 *
 * The distinction is the point of this section. Without custom SMTP, Supabase
 * falls back to its built-in email service, which is capped at a couple of
 * messages an hour and is documented as unsuitable for real use — registration
 * starts failing at the third signup. That is tolerable while developing and is
 * a launch blocker otherwise, so the check is real, but only where it matters.
 *
 * These variables configure SUPABASE, not this application: its auth service
 * sends the email, and nothing in src/ reads them. They are here because a
 * production deployment that cannot send a verification email cannot onboard
 * anyone, and that must be caught before deploy rather than after.
 */
const PRODUCTION = process.env.NODE_ENV === "production" || process.argv.includes("--production");

const SMTP_KEYS = [
  ["SMTP_HOST", "the SMTP server hostname from your provider (e.g. smtp.resend.com)"],
  ["SMTP_PORT", "the port — 587 (STARTTLS), 465 (implicit TLS) or 2525"],
  ["SMTP_USERNAME", "the SMTP username from your provider"],
  ["SMTP_PASSWORD", "the SMTP password or API key from your provider"],
  ["SMTP_FROM_EMAIL", "the verified sender address the emails come from"],
  ["SMTP_FROM_NAME", "the sender display name (defaults to TaskCash Pro)"],
];

const smtpValues = Object.fromEntries(SMTP_KEYS.map(([key]) => [key, env(key)]));
const smtpConfigured = SMTP_KEYS.some(([key]) => Boolean(smtpValues[key]));
const smtpMissing = SMTP_KEYS.filter(([key]) => !smtpValues[key]).map(([key]) => key);

if (!smtpConfigured && !PRODUCTION) {
  // One line, not six, and never a [FAIL]: the app is perfectly usable locally
  // without SMTP, and noise here trains people to ignore this output.
  pass(
    "email",
    "SMTP_CONFIGURATION",
    "not configured — not required in development. Re-run with --production to check it; see .freebuff/run.md",
  );
} else {
  for (const [key, what] of SMTP_KEYS) {
    const value = smtpValues[key];
    if (!value) {
      fail(
        "email",
        key,
        PRODUCTION ? "not set — production cannot send verification email without it" : "not set",
        [
          `Set ${what}.`,
          "  A null SMTP_PASSWORD does not disable email: Supabase silently falls back to its built-in service,",
          "  which allows a couple of messages per hour and fails signup for real users.",
          "  Configure it with: npm run smtp:configure   (values go in .env.local — npm run env:set stores them masked)",
        ].join("\n      "),
      );
      continue;
    }

    // The password is the one value that must never be described. Length only.
    if (key === "SMTP_PASSWORD") {
      pass("email", key, value.length < 8 ? "set (suspiciously short — check it)" : `set (${value.length} chars)`);
      continue;
    }
    if (key === "SMTP_PORT") {
      const port = Number(value);
      if (!Number.isInteger(port) || port <= 0 || port > 65535) {
        fail("email", key, `not a valid port: ${value}`, "Use 587 (STARTTLS), 465 (implicit TLS) or the port your provider documents.");
        continue;
      }
      if (port === 25) {
        fail(
          "email",
          key,
          "port 25 — widely blocked by hosts and providers, and often rate-limited hardest",
          "Use 587 or 465 instead. Port 25 is for server-to-server relay, not authenticated submission.",
        );
        continue;
      }
      pass("email", key, `set (${port})`);
      continue;
    }
    if (key === "SMTP_FROM_EMAIL") {
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) {
        fail("email", key, "does not look like an email address", [
          "Use the address you verified with your provider — sending from an unverified domain is rejected or lands in spam.",
          "  Note: this is NOT the address users should reply to; set a reply-to in the provider instead.",
        ].join("\n      "));
        continue;
      }
      pass("email", key, `set (${value.split("@")[1]})`);
      continue;
    }
    pass("email", key, "set");
  }

  if (smtpMissing.length === 0) {
    pass(
      "email",
      "SMTP_CONFIGURATION",
      "complete — remember to apply it to the project: npm run smtp:configure",
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Payments (M-Pesa / Daraja by default, SasaPay retained)                    */
/* -------------------------------------------------------------------------- */

/**
 * The same policy as SMTP: REQUIRED in production, merely reported in
 * development.
 *
 * An unconfigured payment provider is the safe state, not a broken one — the
 * application refuses deposits, refuses payouts, and says so plainly rather
 * than simulating either. What must not happen is discovering at launch that
 * the merchant account was never wired up, so this becomes a hard failure the
 * moment it is asked about production.
 *
 * Collections and payouts are listed separately because they are separate
 * credential sets in Daraja, and they fail in different places: a missing
 * collection key stops deposits, a missing payout key stops withdrawals after
 * an administrator has already approved one.
 */
const PROVIDER = (env("PAYMENTS_PROVIDER") ?? "mpesa").toLowerCase();

/**
 * Confirms the configured PayHero channel against PayHero itself.
 *
 * `PAYHERO_CHANNEL_ID` was only ever checked for SHAPE — "is it numeric" — which
 * is precisely the check that cannot catch the mistake this exists to prevent.
 * PayHero's *account* id is numeric too, and it is a different number. A
 * deployment configured with the account id authenticates perfectly and then
 * fails every STK push, because no channel with that id exists to route the
 * money to. That is silent, and it looks like the customer never paid.
 *
 * So this asks PayHero's own payment-channel endpoint and confirms the channel
 * EXISTS, is ACTIVE, and sits on the configured account. It never prints a
 * credential: the report names the channel's description and short code, which
 * are the operator-facing identifiers, and nothing else.
 *
 * Unreachability is a FAILURE rather than a note. A payment provider whose
 * channel cannot be confirmed is not a configured payment provider, and "we
 * could not check" must never read as "it is fine". The consequence is that
 * preflight needs network access while PayHero credentials are set, which is a
 * deliberate trade — see the run doc.
 */
async function verifyPayheroChannel() {
  const rawBase = env("PAYHERO_API_URL") ?? "https://backend.payhero.co.ke/api/v2";
  const channelId = env("PAYHERO_CHANNEL_ID");
  const accountId = env("PAYHERO_ACCOUNT_ID");

  const rotate =
    "If either value has been pasted anywhere, rotate it in the PayHero dashboard first.";

  // The same host rule the application enforces, so preflight cannot approve a
  // host the app would refuse at the first payment.
  let base;
  let host;
  try {
    const parsed = new URL(rawBase);
    base = parsed.origin + parsed.pathname.replace(/\/+$/, "");
    host = parsed.hostname.toLowerCase();
    if (parsed.protocol !== "https:") {
      fail(
        "payments",
        "PAYHERO_CHANNEL",
        "PAYHERO_API_URL is not https — the API password would cross in the clear, so nothing was sent",
        "Set PAYHERO_API_URL to https://backend.payhero.co.ke/api/v2",
      );
      return;
    }
  } catch {
    fail(
      "payments",
      "PAYHERO_CHANNEL",
      "PAYHERO_API_URL is not a valid URL, so nothing was checked",
      "Set PAYHERO_API_URL to https://backend.payhero.co.ke/api/v2",
    );
    return;
  }

  if (host !== "payhero.co.ke" && !host.endsWith(".payhero.co.ke")) {
    fail(
      "payments",
      "PAYHERO_CHANNEL",
      `the API host is ${host}, which is not a payhero.co.ke host, so nothing was sent`,
      "Point PAYHERO_API_URL at https://backend.payhero.co.ke/api/v2 — the API password is sent there on every request.",
    );
    return;
  }

  const authorization = `Basic ${Buffer.from(
    `${env("PAYHERO_API_USERNAME")}:${env("PAYHERO_API_PASSWORD")}`,
    "utf8",
  ).toString("base64")}`;

  let response;
  try {
    response = await fetch(`${base}/payment_channels`, {
      headers: { authorization, accept: "application/json" },
      signal: AbortSignal.timeout(15000),
    });
  } catch (error) {
    const why = error && error.name === "TimeoutError" ? "timed out" : "could not be reached";
    fail(
      "payments",
      "PAYHERO_CHANNEL",
      `PayHero ${why}, so the configured channel was NOT confirmed`,
      "Re-run preflight with connectivity. Until the channel is confirmed, a deposit cannot be assumed to route anywhere.",
    );
    return;
  }

  if (response.status === 401 || response.status === 403) {
    fail(
      "payments",
      "PAYHERO_CHANNEL",
      `PayHero rejected the configured API credentials (HTTP ${response.status}) — every deposit would fail`,
      `Check PAYHERO_API_USERNAME / PAYHERO_API_PASSWORD against PayHero → API keys. ${rotate}`,
    );
    return;
  }

  if (!response.ok) {
    fail(
      "payments",
      "PAYHERO_CHANNEL",
      `PayHero answered HTTP ${response.status} when asked for its channel list, so nothing was confirmed`,
      "PayHero may be down. Nothing about the channel was confirmed — do not go live on this run.",
    );
    return;
  }

  const body = await response.json().catch(() => null);
  const channels = body && Array.isArray(body.payment_channels) ? body.payment_channels : null;

  if (!channels) {
    fail(
      "payments",
      "PAYHERO_CHANNEL",
      "PayHero's channel list did not have the shape we understand, so nothing was confirmed",
      "Re-check PayHero's API documentation: the response shape may have changed. Do not go live on an unconfirmed channel.",
    );
    return;
  }

  const match = channels.find((channel) => String(channel && channel.id) === String(channelId));

  // The 12415-versus-12914 case: a numeric id that authenticates perfectly and
  // routes nowhere. Name the ids that DO exist, because that is what an operator
  // needs to spot the substitution.
  if (!match) {
    const known =
      channels
        .map((channel) => `${channel && channel.id} (${(channel && channel.description) ?? "no description"})`)
        .join(", ") || "(none)";
    fail(
      "payments",
      "PAYHERO_CHANNEL",
      `channel ${channelId} does not exist on this account — PayHero reports: ${known}`,
      "The channel id is NOT the account id. Open PayHero → Payment Channels → My Payment Channels, copy the channel id, then: npm run env:set -- --only=PAYHERO_CHANNEL_ID",
    );
    return;
  }

  if (match.is_active !== true) {
    fail(
      "payments",
      "PAYHERO_CHANNEL",
      `channel ${match.id} (${match.description ?? "no description"}) is registered but NOT active`,
      "Activate it in PayHero → Payment Channels. An inactive channel accepts the request and collects nothing.",
    );
    return;
  }

  if (accountId && String(match.account_id) !== String(accountId)) {
    fail(
      "payments",
      "PAYHERO_CHANNEL",
      `channel ${match.id} belongs to account ${match.account_id}, not the configured ${accountId}`,
      "Either correct PAYHERO_ACCOUNT_ID, or point PAYHERO_CHANNEL_ID at a channel on the intended account — money would otherwise land on the wrong account.",
    );
    return;
  }

  const details = [
    match.description ?? "no description",
    match.short_code ? `short code ${match.short_code}` : null,
    match.channel_type ? `${match.channel_type} channel` : null,
    "active",
    accountId
      ? `account ${match.account_id} matches PAYHERO_ACCOUNT_ID`
      : "account id NOT cross-checked (PAYHERO_ACCOUNT_ID unset)",
  ]
    .filter(Boolean)
    .join(", ");

  pass("payments", "PAYHERO_CHANNEL", `channel ${match.id} verified with PayHero — ${details}`);
}

const MPESA_COLLECTION = [
  ["MPESA_CONSUMER_KEY", "the Daraja app's consumer key"],
  ["MPESA_CONSUMER_SECRET", "the Daraja app's consumer secret"],
  ["MPESA_SHORTCODE", "the paybill or till number that collects"],
  ["MPESA_PASSKEY", "the Lipa na M-Pesa passkey for that shortcode"],
  ["MPESA_CALLBACK_URL", "the https URL Safaricom posts the STK result to"],
];

const MPESA_PAYOUT = [
  ["MPESA_B2C_INITIATOR_NAME", "the B2C API operator's username"],
  ["MPESA_B2C_SECURITY_CREDENTIAL", "the initiator password, RSA-encrypted with Safaricom's certificate"],
  ["MPESA_B2C_RESULT_URL", "the https URL Safaricom posts the payout result to"],
  ["MPESA_B2C_QUEUE_TIMEOUT_URL", "the https URL Safaricom posts a queue timeout to"],
];

if (PROVIDER === "sasapay") {
  const SASAPAY_KEYS = [
    "SASAPAY_CLIENT_ID",
    "SASAPAY_CLIENT_SECRET",
    "SASAPAY_MERCHANT_CODE",
    "SASAPAY_API_URL",
  ];
  const missing = SASAPAY_KEYS.filter((key) => !env(key));

  pass("payments", "PAYMENTS_PROVIDER", "sasapay (explicitly selected)");

  if (missing.length === 0) {
    pass("payments", "SASAPAY_CONFIGURATION", "complete");
  } else if (!PRODUCTION) {
    pass(
      "payments",
      "SASAPAY_CONFIGURATION",
      `not configured (missing ${missing.join(", ")}) — deposits and payouts are disabled, which is the safe default`,
    );
  } else {
    for (const key of missing) {
      fail("payments", key, "not set — production cannot move money without it", "Set the SasaPay merchant credentials, then re-run this preflight.");
    }
  }
} else if (PROVIDER === "payhero") {
  /*
    PayHero has no separate collection/payout credential pair: one API
    username/password serves both directions, and the channel id names where the
    money lands. The callback URL is reported because it is the value that must
    be pasted into the PayHero dashboard, and forgetting it is silent — every
    payment stays pending with nothing in the logs to say why.
  */
  const PAYHERO_KEYS = [
    ["PAYHERO_API_USERNAME", "the API username from the PayHero dashboard"],
    ["PAYHERO_API_PASSWORD", "the API password from the PayHero dashboard"],
    ["PAYHERO_CHANNEL_ID", "the payment channel (till/paybill) that receives the money"],
  ];
  const missing = PAYHERO_KEYS.filter(([key]) => !env(key));

  pass("payments", "PAYMENTS_PROVIDER", "payhero (explicitly selected)");
  pass(
    "payments",
    "PAYHERO_CALLBACK_URL",
    `${env("PAYHERO_CALLBACK_URL") ?? `${env("APP_URL") ?? "<APP_URL>"}/api/payments/payhero/callback (derived)`} — register this in the PayHero dashboard`,
  );

  if (missing.length === 0) {
    pass("payments", "PAYHERO_CONFIGURATION", "complete");
    // Credentials are present, so ask PayHero whether they work and whether the
    // channel is real. A shape check cannot tell a channel id from an account id.
    await verifyPayheroChannel();
  } else if (!PRODUCTION) {
    pass(
      "payments",
      "PAYHERO_CONFIGURATION",
      `not configured (missing ${missing.map(([key]) => key).join(", ")}) — deposits and payouts are disabled, which is the safe default`,
    );
  } else {
    for (const [key, what] of missing) {
      fail(
        "payments",
        key,
        "not set — production cannot move money without it",
        `Set ${what} (PayHero → API keys / Payment Channels), then re-run this preflight.`,
      );
    }
  }

  pass(
    "payments",
    "PAYHERO_CALLBACK_VERIFICATION",
    env("PAYHERO_CALLBACK_SECRET") || env("PAYHERO_CALLBACK_IPS")
      ? "configured"
      : "not set — fine locally; callbacks are treated as unverified (they still cannot move money without a PayHero status re-check)",
  );
} else {
  pass("payments", "PAYMENTS_PROVIDER", `mpesa (Daraja) — ${env("PAYMENTS_PROVIDER") ? "explicitly selected" : "the default"}`);
  pass("payments", "MPESA_ENV", `set (${env("MPESA_ENV") ?? "sandbox (default)"})`);

  if (PRODUCTION && (env("MPESA_ENV") ?? "sandbox") !== "production") {
    fail(
      "payments",
      "MPESA_ENV",
      "a production build would call the SANDBOX host",
      "Set MPESA_ENV=production. The application refuses sandbox payouts from a production build, so withdrawals would be blocked.",
    );
  }

  for (const [group, keys, what] of [
    ["COLLECTIONS (deposits)", MPESA_COLLECTION, "a user cannot deposit without it"],
    ["PAYOUTS (withdrawals)", MPESA_PAYOUT, "an approved withdrawal cannot be paid without it"],
  ]) {
    const missing = keys.filter(([key]) => !env(key));

    if (missing.length === 0) {
      pass("payments", `MPESA_${group.split(" ")[0]}_CONFIGURATION`, "complete");
      continue;
    }

    if (!PRODUCTION) {
      pass(
        "payments",
        `MPESA_${group.split(" ")[0]}_CONFIGURATION`,
        `not configured — ${what}. Absent credentials disable the path instead of faking it`,
      );
      continue;
    }

    for (const [key, description] of missing) {
      fail(
        "payments",
        key,
        `not set — ${what}`,
        [
          `Set ${description}.`,
          "  Get it from the Daraja portal: https://developer.safaricom.co.ke → your app → keys and test credentials.",
          "  Set it with: npm run env:set (masked). Never put it behind NEXT_PUBLIC_.",
        ].join("\n      "),
      );
    }
  }

  // Callback authenticity is optional but strongly recommended, and its absence
  // changes what settlement is allowed to trust — so it is reported, not silent.
  const callbackSecret = env("MPESA_CALLBACK_SECRET");
  const callbackIps = env("MPESA_CALLBACK_IPS");
  if (callbackSecret || callbackIps) {
    pass(
      "payments",
      "MPESA_CALLBACK_VERIFICATION",
      callbackSecret ? "set (shared secret; add ?token=… to the registered URLs)" : "set (source IP allowlist)",
    );
  } else if (!PRODUCTION) {
    pass("payments", "MPESA_CALLBACK_VERIFICATION", "not set — fine locally; callbacks are treated as unverified");
  } else {
    fail(
      "payments",
      "MPESA_CALLBACK_VERIFICATION",
      "neither MPESA_CALLBACK_SECRET nor MPESA_CALLBACK_IPS is set",
      [
        "Safaricom does not sign callbacks, so an unauthenticated result cannot be trusted to mark a payout paid.",
        "  Set MPESA_CALLBACK_SECRET and register the callback URLs with ?token=<secret>, or set",
        "  MPESA_CALLBACK_IPS to the Safaricom source addresses. Without one of them, payouts stay in",
        "  processing until an operator confirms them by hand.",
      ].join("\n      "),
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Secret hygiene                                                             */
/* -------------------------------------------------------------------------- */

const leaked = Object.entries(process.env).filter(
  ([key, value]) =>
    key.startsWith("NEXT_PUBLIC_") &&
    typeof value === "string" &&
    // Every one of these is a credential that must never reach a browser:
    // Supabase's server key, the SasaPay secret, the Daraja consumer secret and
    // passkey, and the B2C initiator's encrypted credential.
    /service_role|sb_secret_|SASAPAY_CLIENT_SECRET|MPESA_CONSUMER_SECRET|MPESA_PASSKEY|MPESA_B2C_SECURITY_CREDENTIAL/i.test(
      value,
    ),
);

if (leaked.length === 0) {
  pass("hygiene", "no secret behind a NEXT_PUBLIC_ prefix", "clean");
} else {
  fail(
    "hygiene",
    "no secret behind a NEXT_PUBLIC_ prefix",
    `SECRET EXPOSED in ${leaked.map(([k]) => k).join(", ")} — these are embedded into browser JavaScript`,
    "Move each value to a server-only variable (no NEXT_PUBLIC_ prefix) and ROTATE it: anything shipped to a browser must be considered public.",
  );
}

/* -------------------------------------------------------------------------- */
/* Report                                                                     */
/* -------------------------------------------------------------------------- */

const failures = checks.filter((c) => c.status === "fail");

console.log("\n  TaskCash Pro — configuration preflight\n");
if (!hasEnvLocal) {
  console.log("  · no .env.local found — copy .env.example to .env.local first\n");
}

let currentCategory = null;
for (const check of checks) {
  if (check.category !== currentCategory) {
    currentCategory = check.category;
    console.log(`  ${CATEGORIES[currentCategory]}`);
  }
  const mark = check.status === "pass" ? "[PASS]" : "[FAIL]";
  console.log(`    ${mark} ${check.name.padEnd(38)} ${check.reason}`);
}
console.log("");

if (failures.length > 0) {
  console.log("  To fix:\n");
  for (const check of failures) {
    console.log(`    [FAIL] ${check.name}`);
    console.log(`      Reason: ${check.reason}`);
    console.log(`      Fix:    ${check.fix}\n`);
  }
  console.log(
    `  ${failures.length} required item(s) outstanding. Until these are set the app serves the\n` +
      "  public site and shows \"Platform setup incomplete\" on the auth pages.\n",
  );
  process.exit(1);
}

console.log("  Ready. All checks passed.\n  Next: npm run backend:setup\n");
