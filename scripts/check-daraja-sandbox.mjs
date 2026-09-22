#!/usr/bin/env node
/**
 * Daraja **sandbox** preflight for the M-Pesa STK Push deposit path.
 *
 *   npm run check:daraja
 *
 * This answers one question: is this environment configured to talk to
 * Safaricom's sandbox, and do the credentials actually authenticate there? It is
 * what to run before the first test deposit, and what to run if a test deposit
 * comes back refused.
 *
 * It is deliberately incapable of moving money:
 *
 *   - It issues exactly ONE request, `GET /oauth/v1/generate`, which has no side
 *     effect beyond issuing a token. That is the only Daraja call that is safe to
 *     repeat and safe to run at all.
 *   - It never calls `/mpesa/stkpush/v1/processrequest`. There is no code path in
 *     this file that can send an STK Push, so no customer can be charged by
 *     running it.
 *   - It refuses to run at all when the resolved host is the LIVE host, and when
 *     NODE_ENV is production. A preflight that silently validated production
 *     M-Pesa while you believed you were testing the sandbox is worse than no
 *     preflight.
 *
 * It prints variable NAMES, a host, a shortcode and HTTP statuses — never a
 * credential. The passkey and consumer secret are never read into the output
 * path at all.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const SANDBOX_HOST = "https://sandbox.safaricom.co.ke";
const PRODUCTION_HOST = "https://api.safaricom.co.ke";
/** Safaricom's documented sandbox shortcode. */
const SANDBOX_SHORTCODE = "174379";

/* -------------------------------------------------------------------------- */
/* Environment                                                                */
/* -------------------------------------------------------------------------- */

function loadEnvLocal() {
  const out = new Map();
  const file = resolve(".env.local");
  if (!existsSync(file)) return out;

  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const value = line
      .slice(eq + 1)
      .trim()
      .replace(/^(['"])(.*)\1$/, "$2");
    out.set(line.slice(0, eq).trim(), value);
  }
  return out;
}

const env = loadEnvLocal();
// The process environment wins over .env.local, so a one-off
// `MPESA_ENV=sandbox npm run check:daraja` behaves the way it reads.
const read = (name) => (process.env[name] ?? env.get(name) ?? "").trim();

/* -------------------------------------------------------------------------- */
/* Reporting                                                                  */
/* -------------------------------------------------------------------------- */

let failures = 0;
let warnings = 0;

function pass(label, detail = "") {
  console.log(`  [PASS] ${label}${detail ? `  — ${detail}` : ""}`);
}
function fail(label, detail = "") {
  failures++;
  console.log(`  [FAIL] ${label}${detail ? `  — ${detail}` : ""}`);
}
function warn(label, detail = "") {
  warnings++;
  console.log(`  [WARN] ${label}${detail ? `  — ${detail}` : ""}`);
}
function skip(label) {
  console.log(`  [SKIP] ${label}`);
}

/** A URL with any query token replaced, so nothing secret is printed. */
function describeUrl(raw) {
  try {
    const url = new URL(raw);
    const token = url.searchParams.get("token");
    if (token) url.searchParams.set("token", "<redacted>");
    return url.toString();
  } catch {
    return "<malformed>";
  }
}

/* -------------------------------------------------------------------------- */
/* 1. Guardrails — refuse to validate anything but the sandbox                */
/* -------------------------------------------------------------------------- */

console.log("\nDaraja sandbox preflight — no STK Push, no money, one OAuth call\n");

const nodeEnv = (process.env.NODE_ENV ?? "development").toLowerCase();
const declaredEnv = read("MPESA_ENV") || "sandbox";
const baseOverride = read("MPESA_BASE_URL").replace(/\/+$/, "");

const resolvedHost = declaredEnv === "production" ? PRODUCTION_HOST : SANDBOX_HOST;

console.log("Guardrails");
if (nodeEnv === "production") {
  fail("NODE_ENV", "is production — this preflight refuses to run in a production process");
} else {
  pass("NODE_ENV", nodeEnv);
}

if (resolvedHost === PRODUCTION_HOST) {
  fail(
    "MPESA_ENV",
    "resolves to the LIVE host — set MPESA_ENV=sandbox before running this",
  );
} else {
  pass("MPESA_ENV", "sandbox");
}

if (baseOverride && baseOverride !== SANDBOX_HOST) {
  fail("MPESA_BASE_URL", "disagrees with MPESA_ENV, or names a host that is not Safaricom's");
} else if (baseOverride) {
  pass("MPESA_BASE_URL", "asserts the sandbox host");
} else {
  pass("MPESA_BASE_URL", "unset, so MPESA_ENV decides (recommended)");
}

if (failures > 0) {
  console.log(
    "\n  Refusing to continue: this is not a sandbox environment, so validating it would\n" +
      "  tell you nothing about the sandbox and could contact the live host.\n",
  );
  process.exit(1);
}

/* -------------------------------------------------------------------------- */
/* 2. Configuration — names only, never values                                */
/* -------------------------------------------------------------------------- */

console.log("\nConfiguration");

const REQUIRED = [
  ["MPESA_CONSUMER_KEY", "the sandbox app's consumer key"],
  ["MPESA_CONSUMER_SECRET", "the sandbox app's consumer secret"],
  ["MPESA_SHORTCODE", "the paybill or till that collects"],
  ["MPESA_PASSKEY", "the Lipa na M-Pesa passkey"],
  ["MPESA_CALLBACK_URL", "the https URL Safaricom posts the STK result to"],
];

const missing = REQUIRED.filter(([name]) => !read(name)).map(([name]) => name);
if (missing.length === 0) {
  pass("M-Pesa collection credentials", "all present");
} else {
  fail("M-Pesa collection credentials", `missing ${missing.join(", ")}`);
  console.log(
    "\n  Enter them with the masked prompt (one key per run, value never echoed):\n" +
      missing.map((name) => `    npm run env:set -- --only=${name}`).join("\n") +
      "\n",
  );
}

const provider = (read("PAYMENTS_PROVIDER") || "").toLowerCase();
if (provider === "mpesa") {
  pass("PAYMENTS_PROVIDER", "mpesa — deposits route to Daraja");
} else if (provider) {
  fail(
    "PAYMENTS_PROVIDER",
    `is "${provider}" — deposits would not reach Daraja at all. Set PAYMENTS_PROVIDER=mpesa.`,
  );
} else {
  fail(
    "PAYMENTS_PROVIDER",
    "unset, so the fallback applies and PayHero is preferred whenever its credentials are present",
  );
}

const shortcode = read("MPESA_SHORTCODE");
if (!shortcode) {
  skip("MPESA_SHORTCODE");
} else if (shortcode === SANDBOX_SHORTCODE) {
  pass("MPESA_SHORTCODE", `${SANDBOX_SHORTCODE} (Safaricom's documented sandbox shortcode)`);
} else {
  warn(
    "MPESA_SHORTCODE",
    `is ${shortcode}, not Safaricom's documented sandbox shortcode ${SANDBOX_SHORTCODE} — ` +
      "a number from a live app will be refused by the sandbox host",
  );
}

const transactionType = read("MPESA_TRANSACTION_TYPE") || "CustomerPayBillOnline";
pass("MPESA_TRANSACTION_TYPE", transactionType);

/* -------------------------------------------------------------------------- */
/* 3. Callback — reachable-looking and token-protected                        */
/* -------------------------------------------------------------------------- */

console.log("\nCallback");

const callbackUrl = read("MPESA_CALLBACK_URL");
const callbackSecret = read("MPESA_CALLBACK_SECRET");

let callbackToken = null;
if (!callbackUrl) {
  skip("MPESA_CALLBACK_URL");
} else {
  let parsed = null;
  try {
    parsed = new URL(callbackUrl);
  } catch {
    fail("MPESA_CALLBACK_URL", "is not a valid URL");
  }

  if (parsed) {
    callbackToken = parsed.searchParams.get("token");
    pass("MPESA_CALLBACK_URL", describeUrl(callbackUrl));

    if (parsed.protocol !== "https:") {
      fail("MPESA_CALLBACK_URL", "is not https — Safaricom does not call back over http");
    }
    if (/^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)$/i.test(parsed.hostname)) {
      fail(
        "MPESA_CALLBACK_URL",
        "points at localhost, which Safaricom cannot reach — start a public HTTPS tunnel first",
      );
    } else {
      pass("MPESA_CALLBACK_URL host", parsed.hostname);
    }
  }
}

if (callbackSecret) {
  if (callbackToken) {
    pass("MPESA_CALLBACK_SECRET", "set, and the callback URL carries a token");
  } else {
    fail(
      "MPESA_CALLBACK_SECRET",
      "is set but MPESA_CALLBACK_URL carries no ?token=…, so every callback would be rejected 401 " +
        "and deposits would only settle via the status query",
    );
  }
} else {
  warn(
    "MPESA_CALLBACK_SECRET",
    "not set — callbacks are accepted as unverified. Settlement still re-checks with Safaricom, " +
      "so a forged callback cannot credit a deposit; set a secret to also reject the delivery",
  );
  if (callbackToken) {
    warn("MPESA_CALLBACK_URL token", "is present in the URL but no secret is configured to match it");
  }
}

/* -------------------------------------------------------------------------- */
/* 4. Authentication — the only live call this script makes                   */
/* -------------------------------------------------------------------------- */

console.log("\nAuthentication (GET /oauth/v1/generate — no transaction is created)");

if (missing.includes("MPESA_CONSUMER_KEY") || missing.includes("MPESA_CONSUMER_SECRET")) {
  skip("OAuth token request — needs MPESA_CONSUMER_KEY and MPESA_CONSUMER_SECRET");
} else {
  const basic = Buffer.from(`${read("MPESA_CONSUMER_KEY")}:${read("MPESA_CONSUMER_SECRET")}`).toString(
    "base64",
  );

  let response = null;
  let body = null;
  try {
    response = await fetch(`${resolvedHost}/oauth/v1/generate?grant_type=client_credentials`, {
      method: "GET",
      headers: { Authorization: `Basic ${basic}` },
      signal: AbortSignal.timeout(20_000),
    });
    body = await response.text();
  } catch (error) {
    fail(
      "OAuth token request",
      error?.name === "TimeoutError" ? "timed out" : "could not reach the sandbox host",
    );
  }

  if (response) {
    if (response.ok) {
      let parsed = null;
      try {
        parsed = JSON.parse(body);
      } catch {
        /* handled below */
      }
      if (parsed?.access_token) {
        // The token itself is never printed, and never stored.
        pass(
          "OAuth token request",
          `HTTP ${response.status} — access_token received, expires_in ${parsed.expires_in ?? "unknown"}s`,
        );
      } else {
        fail("OAuth token request", `HTTP ${response.status} but no access_token in the response`);
      }
    } else if (response.status === 401 || response.status === 403) {
      fail(
        "OAuth token request",
        `HTTP ${response.status} — the consumer key and secret were rejected. Check you copied the ` +
          "values from the SANDBOX app on the Daraja portal.",
      );
    } else {
      fail("OAuth token request", `HTTP ${response.status}`);
    }
  }
}

/* -------------------------------------------------------------------------- */
/* 5. What a test deposit would do                                            */
/* -------------------------------------------------------------------------- */

console.log("\nWhat a test deposit would call (not called here)");
console.log(`  POST ${resolvedHost}/mpesa/stkpush/v1/processrequest`);
console.log("    BusinessShortCode  <MPESA_SHORTCODE>");
console.log("    TransactionType    " + transactionType);
console.log("    PartyA / PhoneNumber  the customer's number, normalised to 2547…");
console.log("    CallBackURL         <MPESA_CALLBACK_URL>");
console.log("    Password            Shortcode + Passkey + Timestamp, base64 (never logged)");

console.log(
  `\n${failures} failure(s), ${warnings} warning(s). ` +
    "No STK Push was sent, no payment was requested, and no deposit row was created.\n",
);

process.exit(failures > 0 ? 1 : 0);
