#!/usr/bin/env node
/**
 * Put the two server secrets into .env.local without an editor, a shell
 * history entry, or a chat message.
 *
 *   npm run env:set                      # interactive, input masked
 *   npm run env:set -- --dry-run         # validate only, write nothing
 *   npm run env:set -- --only=SUPABASE_ACCESS_TOKEN   # prompt for just this one
 *
 * Paste into a masked prompt is the point: keys get mangled by hand-editing
 * (a doubled `sb_publishable_` prefix cost us one already), and a heredoc
 * leaves the value in the terminal scrollback.
 *
 * Values are never echoed and never printed back — only their length, and a
 * verdict on whether they look like the right kind of credential. Existing
 * lines are replaced in place; nothing else in the file is touched.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compromisedMatch } from "./lib/compromised-keys.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENV_FILE = join(ROOT, ".env.local");
const DRY_RUN = process.argv.includes("--dry-run");

/* -------------------------------------------------------------------------- */
/* Masked input                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Piped input is drained once, into a queue of lines.
 *
 * Reading a line at a time from a stream is a trap: the first chunk usually
 * arrives holding several lines, so the leftovers are lost and the next read
 * hangs waiting for data that has already been consumed.
 */
let pipedLines = null;
async function lineFromPipe() {
  if (pipedLines === null) {
    let buf = "";
    process.stdin.setEncoding("utf8");
    for await (const chunk of process.stdin) buf += chunk;
    pipedLines = buf.split(/\r?\n/);
  }
  const next = pipedLines.shift();
  return next === undefined ? "" : next;
}

function readMasked(label) {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    const canMask = Boolean(stdin.isTTY && stdin.setRawMode);

    if (!canMask) {
      // Piped input (CI, heredoc). No masking to do — the values came from a
      // file or a pipe, not a keyboard.
      lineFromPipe().then((line) => resolve(line.trim()), reject);
      return;
    }

    process.stdout.write(`  ${label}\n  > `);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");

    let value = "";
    const done = (result) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
      process.stdout.write("\n");
      resolve(result);
    };

    const onData = (char) => {
      if (char === "\u0003") {
        // Ctrl+C
        stdin.setRawMode(false);
        process.stdout.write("\n");
        process.exit(130);
      }
      if (char === "\r" || char === "\n") return done(value.trim());
      if (char === "\u007f" || char === "\b") {
        if (value.length > 0) {
          value = value.slice(0, -1);
          process.stdout.write("\b \b");
        }
        return;
      }
      // Bracketed paste arrives as one chunk with control sequences around it.
      const clean = char.replace(/\u001b\[200~|\u001b\[201~/g, "");
      value += clean;
      process.stdout.write("*".repeat(clean.length));
    };

    stdin.on("data", onData);
  });
}

/* -------------------------------------------------------------------------- */
/* Validation — shape only, never authenticity                                */
/* -------------------------------------------------------------------------- */

function checkSecretKey(value) {
  if (!value) return "empty";
  // Refuse to write back a key already known to be exposed — pasting is exactly
  // how a compromised key gets reinstated after someone rotates it.
  const burned = compromisedMatch(value);
  if (burned) return `is a key known to be ${burned.note} — create a replacement instead`;
  if (/^(sb_secret_)/.test(value)) return null;
  if (/^ey[A-Za-z0-9_-]+\./.test(value)) return null; // legacy service_role JWT
  if (/^sb_publishable_/.test(value)) return "that is the PUBLISHABLE key, not the secret key";
  if (/^(your|xxx|placeholder|<)/i.test(value)) return "still a placeholder";
  return "does not look like a key (expected `sb_secret_…` or a legacy service_role JWT)";
}

function checkDatabaseUrl(value) {
  if (!value) return "empty";
  let url;
  try {
    url = new URL(value);
  } catch {
    return "is not a valid URL";
  }
  if (!/^postgres(ql)?:$/.test(url.protocol)) return "must start with postgresql://";
  if (!url.password) return "has no password — replace [YOUR-PASSWORD] in the string";
  if (/YOUR-PASSWORD|\[.*\]/.test(value)) return "still contains the [YOUR-PASSWORD] placeholder";
  if (url.port === "6543") {
    return "is the TRANSACTION pooler (port 6543) — migrations need the SESSION pooler";
  }
  return null;
}

/* -------------------------------------------------------------------------- */

function checkAccessToken(value) {
  if (!value) return "empty";
  if (/^sbp_/.test(value)) return null;
  if (/^sb_/.test(value)) {
    return "that is a project API key, not a personal access token (expected `sbp_…`)";
  }
  if (/^(your|xxx|placeholder|<)/i.test(value)) return "still a placeholder";
  return "does not look like a personal access token (expected `sbp_…`)";
}

function checkJwksUrl(value) {
  if (!value) return "empty";
  if (!/^https?:\/\//.test(value)) return "must be an https:// URL";
  if (!value.endsWith("/auth/v1/.well-known/jwks.json")) {
    return "should end with /auth/v1/.well-known/jwks.json";
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* M-Pesa (Daraja) — production                                               */
/* -------------------------------------------------------------------------- */

/**
 * Shape checks only. Nothing here can tell whether Safaricom will accept a
 * credential — only the Daraja portal can. What these prevent is the class of
 * mistake that is invisible until a payment fails: a pasted placeholder, a
 * truncated credential, a callback URL pointing at the wrong route, or a
 * sandbox shortcode in a production build.
 */
function notPlaceholder(value) {
  if (/^(your|xxx|placeholder|todo|<)/i.test(value) || /<[^>]+>/.test(value)) {
    return "still a placeholder — paste the real value from the Daraja portal";
  }
  return null;
}

function checkConsumerKey(value) {
  if (!value) return "empty";
  const placeholder = notPlaceholder(value);
  if (placeholder) return placeholder;
  if (value.length < 12) return "is too short for a Daraja consumer key";
  if (/\s/.test(value)) return "contains whitespace — the value was probably copied with a line break";
  return null;
}

function checkConsumerSecret(value) {
  if (!value) return "empty";
  const placeholder = notPlaceholder(value);
  if (placeholder) return placeholder;
  if (/\s/.test(value)) return "contains whitespace — the value was probably copied with a line break";
  if (value.length < 16) return "is too short for a Daraja consumer secret";
  return null;
}

function checkShortcode(value) {
  if (!value) return "empty";
  if (!/^\d{5,7}$/.test(value)) {
    return "must be digits only (5–7) — the paybill or till number, not the store name";
  }
  return null;
}

function checkPasskey(value) {
  if (!value) return "empty";
  const placeholder = notPlaceholder(value);
  if (placeholder) return placeholder;
  if (!/^[A-Za-z0-9+/=_-]+$/.test(value)) return "does not look like a Lipa na M-Pesa passkey";
  if (value.length < 16) return "is too short for a passkey";
  return null;
}

/**
 * Callback URLs must be the routes that actually exist.
 *
 * This is worth failing on rather than warning about. A callback registered at
 * the wrong path is accepted by Safaricom, delivers nothing, and looks exactly
 * like "the customer never paid" — with money already taken from their phone.
 */
function checkCallbackUrl(expectedPath) {
  return (value) => {
    if (!value) return "empty";
    let url;
    try {
      url = new URL(value);
    } catch {
      return "is not a valid URL";
    }
    if (url.protocol !== "https:") {
      return "must be https — Safaricom does not POST results over http, so every callback would be lost";
    }
    if (/^(localhost|127\.0\.0\.1|\[::1\])$/i.test(url.hostname)) {
      return "points at localhost, which Safaricom cannot reach";
    }
    if (!url.pathname.endsWith(expectedPath)) {
      return `must end with ${expectedPath} — that is the route that exists`;
    }
    return null;
  };
}

function checkInitiatorName(value) {
  if (!value) return "empty";
  if (/\s/.test(value)) return "must not contain spaces (it is the B2C API operator username)";
  return null;
}

function checkSecurityCredential(value) {
  if (!value) return "empty";
  if (!/^[A-Za-z0-9+/=\s]+$/.test(value)) return "must be base64 (the RSA-encrypted initiator password)";
  // The encrypted value is long; a short one is the plaintext password pasted by
  // mistake, which Safaricom rejects at B2C time — after an admin has approved.
  if (value.replace(/\s/g, "").length < 100) {
    return (
      "is too short to be an encrypted credential — this must be the initiator password " +
      "RSA-encrypted with Safaricom's production certificate, not the password itself"
    );
  }
  return null;
}

function checkPayheroUsername(value) {
  if (!value) return "empty";
  if (/\s/.test(value)) return "must not contain spaces (it is the PayHero API username)";
  return null;
}

function checkPayheroChannelId(value) {
  if (!value) return "empty";
  return /^\d+$/.test(value)
    ? null
    : "must be numeric — the payment channel id from PayHero → Payment Channels → My Payment Channels";
}

/**
 * PayHero credentials.
 *
 * The API username/password come from https://app.payhero.co.ke and are sent as
 * HTTP Basic on every request. The channel id names which till/paybill receives
 * the money, and the STK push cannot be routed without it.
 */
const PAYHERO_FIELDS = [
  {
    key: "PAYHERO_API_USERNAME",
    label: "PayHero API username  (PayHero dashboard → API keys; press Enter to skip)",
    check: checkPayheroUsername,
  },
  {
    key: "PAYHERO_API_PASSWORD",
    label: "PayHero API password  (press Enter to skip)",
    check: (value) => (value ? null : "empty"),
  },
  {
    key: "PAYHERO_CHANNEL_ID",
    label:
      "PayHero payment channel id  (PayHero → Payment Channels → My Payment Channels; press Enter to skip)",
    check: checkPayheroChannelId,
  },
  {
    key: "PAYHERO_CALLBACK_URL",
    label:
      "Payment callback URL  (https://<domain>/api/payments/payhero/callback; press Enter to skip)",
    check: checkCallbackUrl("/api/payments/payhero/callback"),
  },
  {
    key: "PAYHERO_CALLBACK_SECRET",
    label:
      "Callback shared secret  (register the URL with ?token=<secret>; min 16 chars; press Enter to skip)",
    check: (value) => {
      if (!value) return "empty";
      return value.length < 16 ? "must be at least 16 characters" : null;
    },
  },
  {
    key: "PAYHERO_DEFAULT_NETWORK_CODE",
    label:
      "Default payout network code  (SasaPay code for the destination telco; press Enter to skip)",
    check: (value) => (value ? null : "empty"),
  },
];

const MPESA_FIELDS = [
  {
    key: "MPESA_CONSUMER_KEY",
    label:
      "M-Pesa consumer key  (Daraja → your PRODUCTION app → Consumer Key; press Enter to skip)",
    check: checkConsumerKey,
  },
  {
    key: "MPESA_CONSUMER_SECRET",
    label: "M-Pesa consumer secret  (press Enter to skip)",
    check: checkConsumerSecret,
  },
  {
    key: "MPESA_SHORTCODE",
    label: "M-Pesa shortcode  (the production paybill or till that collects; press Enter to skip)",
    check: checkShortcode,
  },
  {
    key: "MPESA_PASSKEY",
    label: "Lipa na M-Pesa passkey  (press Enter to skip)",
    check: checkPasskey,
  },
  {
    key: "MPESA_CALLBACK_URL",
    label:
      "STK result callback URL  (https://<domain>/api/payments/mpesa/callback; press Enter to skip)",
    check: checkCallbackUrl("/api/payments/mpesa/callback"),
  },
  {
    key: "MPESA_B2C_INITIATOR_NAME",
    label: "B2C initiator username  (press Enter to skip)",
    check: checkInitiatorName,
  },
  {
    key: "MPESA_B2C_SECURITY_CREDENTIAL",
    label: "B2C security credential (RSA-encrypted initiator password; press Enter to skip)",
    check: checkSecurityCredential,
  },
  {
    key: "MPESA_B2C_RESULT_URL",
    label: "B2C result callback URL  (…/api/payments/mpesa/b2c/result; press Enter to skip)",
    check: checkCallbackUrl("/api/payments/mpesa/b2c/result"),
  },
  {
    key: "MPESA_B2C_QUEUE_TIMEOUT_URL",
    label: "B2C queue-timeout URL  (…/api/payments/mpesa/b2c/timeout; press Enter to skip)",
    check: checkCallbackUrl("/api/payments/mpesa/b2c/timeout"),
  },
  {
    key: "MPESA_CALLBACK_SECRET",
    label:
      "Callback shared secret  (register the URLs with ?token=<secret>; min 16 chars; press Enter to skip)",
    check: (value) => {
      if (!value) return "empty";
      return value.length < 16 ? "must be at least 16 characters" : null;
    },
  },
];

const FIELDS = [
  {
    key: "SUPABASE_SECRET_KEY",
    label: "Supabase secret key  (Project Settings → API Keys → secret key)",
    check: checkSecretKey,
  },
  {
    key: "DATABASE_URL",
    label: "Postgres connection string  (Project Settings → Database → Session pooler)",
    check: checkDatabaseUrl,
  },
  {
    key: "SUPABASE_JWKS_URL",
    label: "JWKS URL  (press Enter to skip — optional, defaults to <project>/auth/v1/.well-known/jwks.json)",
    check: checkJwksUrl,
  },
  {
    // Tooling only: `npm run db:push-sql` uses this to apply SQL over HTTPS when
    // DATABASE_URL is unavailable. Nothing in src/ reads it, and it is not part
    // of the app's configuration. Account-wide — delete it when finished.
    key: "SUPABASE_ACCESS_TOKEN",
    label:
      "Supabase personal access token  (press Enter to skip — Account → Access Tokens; used only by db:push-sql)",
    check: checkAccessToken,
  },
  // Payment credentials last, deliberately: the Supabase secrets are set far
  // more often, and making every one of those runs skip sixteen payment prompts
  // is a bad trade.
  ...PAYHERO_FIELDS,
  ...MPESA_FIELDS,
];

if (!existsSync(ENV_FILE)) {
  console.error(`\n  ✗ ${ENV_FILE} does not exist. Copy .env.example first.\n`);
  process.exit(1);
}

/* -------------------------------------------------------------------------- */
/* Non-secret configuration                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Rewrite in place, line by line: comments and unrelated keys survive, and no
 * key can end up defined twice (duplicate keys resolve inconsistently between
 * loaders — first-wins in scripts/preflight.mjs, last-wins in Next.js).
 */
function writeEnv(pairs) {
  const lines = readFileSync(ENV_FILE, "utf8").split(/\r?\n/);
  let changed = 0;

  for (const { key, value } of pairs) {
    const at = lines.findIndex((line) => new RegExp(`^\\s*${key}\\s*=`).test(line));
    const rendered = `${key}=${value}`;
    if (at === -1) lines.push(rendered);
    else lines[at] = rendered;
    changed += 1;
  }

  if (DRY_RUN) return { changed, written: false };
  writeFileSync(ENV_FILE, lines.join("\n").replace(/\n*$/, "") + "\n");
  return { changed, written: true };
}

/**
 * `--config KEY=VALUE` exists so that non-secret settings can be scripted —
 * which `MPESA_ENV=production` had to be, because it is a mode, not a secret,
 * and it must never be typed into a chat or a shell history either.
 *
 * There is no way to put a credential through this path: the keys are
 * allowlisted by name, so `--config MPESA_CONSUMER_SECRET=…` is refused no
 * matter how it is spelled. Secrets only ever arrive through the masked prompt
 * below, where nothing is echoed.
 */
const NON_SECRET_CONFIG = {
  MPESA_ENV: (v) =>
    v === "production" || v === "sandbox" ? null : "must be `production` or `sandbox`",
  PAYMENTS_PROVIDER: (v) =>
    v === "mpesa" || v === "sasapay" || v === "payhero"
      ? null
      : "must be `mpesa`, `sasapay` or `payhero`",
  /*
    The PayHero account the channel should belong to. Not a credential, so it
    belongs on this scriptable path rather than the masked one: it identifies
    where money should land, and preflight compares it against the account the
    configured channel actually reports.
  */
  PAYHERO_ACCOUNT_ID: (v) => (/^\d+$/.test(v) ? null : "must be numeric — the PayHero account id"),
  MPESA_TRANSACTION_TYPE: (v) =>
    v === "CustomerPayBillOnline" || v === "CustomerBuyGoodsOnline"
      ? null
      : "must be CustomerPayBillOnline (paybill) or CustomerBuyGoodsOnline (till)",
  MPESA_B2C_COMMAND_ID: (v) =>
    ["BusinessPayment", "SalaryPayment", "PromotionPayment"].includes(v)
      ? null
      : "must be BusinessPayment, SalaryPayment or PromotionPayment",
  MPESA_B2C_SHORTCODE: (v) => (/^\d{5,7}$/.test(v) ? null : "must be 5–7 digits"),
  MPESA_TIMEOUT_MS: (v) => (Number(v) > 0 ? null : "must be a positive number of milliseconds"),
  APP_URL: (v) => (/^https?:\/\//.test(v) ? null : "must be an http(s) URL"),
};

const configPairs = [];
for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i];
  const raw = arg.startsWith("--config=") ? arg.slice("--config=".length) : arg === "--config" ? (process.argv[++i] ?? "") : null;
  if (raw === null) continue;

  const eq = raw.indexOf("=");
  const key = (eq === -1 ? raw : raw.slice(0, eq)).trim();
  const value = (eq === -1 ? "" : raw.slice(eq + 1)).trim();
  const check = NON_SECRET_CONFIG[key];

  if (!check) {
    console.error(
      `\n  ✗ ${key || "(no key)"} cannot be set with --config.\n` +
        "    Only non-secret settings are allowed here: " +
        `${Object.keys(NON_SECRET_CONFIG).join(", ")}.\n` +
        "    Credentials must go through the masked prompt: npm run env:set\n",
    );
    process.exit(2);
  }

  const problem = check(value);
  if (problem) {
    console.error(`\n  ✗ ${key} ${problem}\n`);
    process.exit(2);
  }

  configPairs.push({ key, value });
}

if (configPairs.length > 0) {
  const { changed, written } = writeEnv(configPairs);
  for (const pair of configPairs) console.log(`  ✓ ${pair.key}=${pair.value}`);
  console.log(
    DRY_RUN
      ? `\n  · dry run: would set ${changed} key(s). Nothing written.\n`
      : `\n  ✓ ${ENV_FILE} updated (${changed} key${changed === 1 ? "" : "s"}). Nothing else touched.\n`,
  );
  if (written && configPairs.some((p) => p.key === "MPESA_ENV")) {
    console.log(
      "  Note: MPESA_ENV=production points every M-Pesa call at https://api.safaricom.co.ke.\n" +
        "  Until the production credentials are set, deposits and payouts fail closed — which is\n" +
        "  the intended behaviour, not a bug. Run `npm run preflight` for the exact list.\n",
    );
  }
  process.exit(0);
}

/**
 * `--only=KEY[,KEY]` prompts for just those fields.
 *
 * The full list is twenty-odd prompts, so re-setting ONE credential meant
 * pressing Enter through every other one — slow, and an easy way to type a value
 * into the wrong prompt. Filtering is by exact key name and an unknown key is
 * refused outright, so a typo can never quietly prompt for nothing.
 */
const ONLY = (() => {
  const arg = process.argv.find((a) => a.startsWith("--only=")) ?? null;
  if (!arg) return null;

  const keys = arg
    .slice("--only=".length)
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);

  const unknown = keys.filter((k) => !FIELDS.some((f) => f.key === k));
  if (keys.length === 0 || unknown.length > 0) {
    console.error(
      `\n  ✗ --only needs known key names.` +
        (unknown.length > 0 ? ` Unknown: ${unknown.join(", ")}.` : " None given.") +
        `\n    Available: ${FIELDS.map((f) => f.key).join(", ")}\n`,
    );
    process.exit(2);
  }
  return keys;
})();

console.log(
  `\n  TaskCash Pro — set server secrets${DRY_RUN ? "  (dry run: nothing will be written)" : ""}` +
    `${ONLY ? `\n  Only: ${ONLY.join(", ")}` : ""}\n`,
);
console.log("  Input is masked. Nothing is echoed, logged, or sent anywhere.\n");

const collected = [];
for (const field of ONLY ? FIELDS.filter((f) => ONLY.includes(f.key)) : FIELDS) {
  for (;;) {
    const value = (await readMasked(field.label)).trim();
    const problem = field.check(value);
    if (problem === "empty") {
      console.log(`  · ${field.key}: skipped (already set, or not filled in yet)\n`);
      collected.push({ ...field, value: null });
      break;
    }
    if (problem) {
      console.log(`  ✗ ${field.key} ${problem}. Try again.\n`);
      continue;
    }
    console.log(`  ✓ ${field.key} accepted — ${value.length} characters\n`);
    collected.push({ ...field, value });
    break;
  }
}

const toWrite = collected.filter((f) => f.value);
if (toWrite.length === 0) {
  console.log("  Nothing to write. Run `npm run preflight` to see what is still missing.\n");
  process.exit(0);
}

// Rewrite the file line by line, so comments and unrelated keys survive and no
// key can end up defined twice (duplicate keys resolve inconsistently between
// loaders — first-wins in scripts/preflight.mjs, last-wins in Next.js).
const { changed, written } = writeEnv(toWrite.map((f) => ({ key: f.key, value: f.value })));

if (!written) {
  console.log(`  · dry run: would set ${changed} key(s). Nothing written.\n`);
  process.exit(0);
}

console.log(`  ✓ ${ENV_FILE} updated (${changed} key${changed === 1 ? "" : "s"}). Nothing else touched.\n`);
console.log("  Next: npm run preflight        then: npm run backend:setup\n");
