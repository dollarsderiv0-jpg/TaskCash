#!/usr/bin/env node
/**
 * Push TaskCash Pro environment variables to the linked Vercel project.
 *
 * WHY THIS EXISTS
 * ---------------
 * `vercel env add <name>` reads the value from **stdin**, not argv. That matters:
 * a value passed as a command-line argument lands in the process table and in
 * shell history, and a value echoed for confirmation lands in logs. This script
 * therefore only ever writes values to a child process's stdin, and prints
 * variable NAMES and outcomes — never values.
 *
 * It also refuses the two mistakes that are easy to make by hand:
 *
 *   1. Pushing .env.local verbatim. That file describes a LOCAL development
 *      machine: APP_URL and NEXT_PUBLIC_APP_URL are http://localhost:4177, and
 *      the run doc records that APP_URL is what password-reset and email
 *      confirmation links are built from. Mirroring it would produce a
 *      production deployment that emails people links to localhost. So the
 *      pass-through set below is an explicit allowlist, and every URL-shaped
 *      variable is derived from `--url` instead.
 *
 *   2. Pushing an incomplete payment configuration silently. Anything absent
 *      from .env.local is reported as skipped, so a run of this script is also
 *      an audit of what production is still missing.
 *
 * USAGE
 * -----
 *   node scripts/vercel-env-sync.mjs --url https://taskcash-pro.vercel.app
 *   node scripts/vercel-env-sync.mjs --url https://example.com --target preview
 *   node scripts/vercel-env-sync.mjs --url https://example.com --generate-cron-secret
 *
 * Requires the project to be linked (`vercel link`).
 */

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, appendFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const ENV_FILE = resolve(ROOT, ".env.local");

/** Values identical in every environment, taken from this repository's own code. */
const CONSTANTS = {
  // PayHero is the active provider. The M-Pesa variables below are still pushed
  // so that switching back is a one-variable change, but nothing routes to them
  // while PAYMENTS_PROVIDER names payhero.
  PAYMENTS_PROVIDER: "payhero",
  MPESA_ENV: "production",
  MPESA_TRANSACTION_TYPE: "CustomerPayBillOnline",
  // The Daraja production host. mpesa/config.ts treats this as an assertion that
  // must agree with MPESA_ENV, and refuses Safaricom's sandbox host in production.
  MPESA_BASE_URL: "https://api.safaricom.co.ke",
};

/** Copied from .env.local when present — these are server-side or public-by-design. */
const PASSTHROUGH = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
  "SUPABASE_JWKS_URL",
  "SUPABASE_SECRET_KEY",
  "AUTH_SECRET",
  // PayHero credentials, read from .env.local and pushed without ever being
  // printed. Absent ones are reported as skipped rather than set to empty,
  // which would read as "configured" to the readiness checks.
  "PAYHERO_API_USERNAME",
  "PAYHERO_API_PASSWORD",
  "PAYHERO_CHANNEL_ID",
  "PAYHERO_CALLBACK_SECRET",
  "PAYHERO_DEFAULT_NETWORK_CODE",
];

/**
 * URL-shaped variables, derived from --url. These must be the real deployed
 * origin: the M-Pesa ones are registered with Safaricom and mpesa/config.ts
 * refuses http:// and refuses localhost in production.
 */
const fromUrl = (base) => ({
  APP_URL: base,
  NEXT_PUBLIC_APP_URL: base,
  // PayHero's callback. This is the URL to paste into the PayHero dashboard.
  PAYHERO_CALLBACK_URL: `${base}/api/payments/payhero/callback`,
  MPESA_CALLBACK_URL: `${base}/api/payments/mpesa/callback`,
  MPESA_B2C_RESULT_URL: `${base}/api/payments/mpesa/b2c/result`,
  MPESA_B2C_QUEUE_TIMEOUT_URL: `${base}/api/payments/mpesa/b2c/timeout`,
});

/**
 * Vercel stores variables as `secret` by default, which makes them write-only:
 * the CLI's own advice is to use `config` "for values you need to read later".
 * Public-by-design values are `config` so they stay inspectable and pullable —
 * which is also an honest statement of their sensitivity. Anything that grants
 * access or moves money stays `secret`.
 */
const SECRET_TYPE = new Set([
  "SUPABASE_SECRET_KEY",
  "AUTH_SECRET",
  "CRON_SECRET",
  "MPESA_CONSUMER_KEY",
  "MPESA_CONSUMER_SECRET",
  "MPESA_PASSKEY",
  "MPESA_B2C_SECURITY_CREDENTIAL",
  "MPESA_CALLBACK_SECRET",
  "PAYHERO_API_USERNAME",
  "PAYHERO_API_PASSWORD",
  "PAYHERO_CALLBACK_SECRET",
]);

function parseArgs(argv) {
  const args = { target: "production", url: null, cron: false, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--target") args.target = argv[++i];
    else if (arg === "--url") args.url = argv[++i];
    else if (arg === "--generate-cron-secret") args.cron = true;
    else if (arg === "--dry-run") args.dryRun = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!["production", "preview", "development"].includes(args.target)) {
    throw new Error(`--target must be production, preview or development (got ${args.target})`);
  }
  return args;
}

/** Minimal .env parser: KEY=VALUE, optional surrounding quotes. */
function readEnvLocal() {
  if (!existsSync(ENV_FILE)) throw new Error(`${ENV_FILE} not found`);
  const out = new Map();
  for (const raw of readFileSync(ENV_FILE, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    out.set(
      line.slice(0, eq).trim(),
      line.slice(eq + 1).trim().replace(/^(['"])(.*)\1$/, "$2"),
    );
  }
  return out;
}

/**
 * The value travels on stdin and never in argv, so it cannot appear in the
 * process table, in shell history, or in this script's output. `shell: true` is
 * required because a bare `npx.cmd` spawn fails on Windows; every argument is
 * either a fixed name from the allowlists above or a constant, so there is
 * nothing here for a shell to reinterpret.
 */
function push(name, value, target) {
  const type = SECRET_TYPE.has(name) ? "secret" : "config";
  const command = ["npx", "--yes", "vercel@latest", "env", "add", name, target, "--force", "-y", "--type", type].join(" ");
  const result = spawnSync(command, { cwd: ROOT, input: value, encoding: "utf8", shell: true });
  if (result.status !== 0) {
    const output = `${result.stdout || ""}\n${result.stderr || ""}`.trim();
    const detail = output.split("\n").map((l) => l.trim()).filter(Boolean).pop() || "no output";
    return { ok: false, detail };
  }
  return { ok: true, type };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const env = readEnvLocal();
  const plan = new Map();

  for (const [name, value] of Object.entries(CONSTANTS)) plan.set(name, value);

  for (const name of PASSTHROUGH) {
    const value = env.get(name);
    if (value) plan.set(name, value);
  }

  if (args.url) {
    const base = args.url.replace(/\/+$/, "");
    if (!base.startsWith("https://")) {
      throw new Error("--url must be https:// — Safaricom rejects http and localhost callbacks");
    }
    for (const [name, value] of Object.entries(fromUrl(base))) plan.set(name, value);
    console.log(`URL-derived variables use ${base}`);
  } else {
    console.log("No --url given: APP_URL and the M-Pesa callback URLs are NOT being set.");
  }

  // CRON_SECRET authenticates Vercel's own cron invocations: Vercel sends it as
  // `Authorization: Bearer <CRON_SECRET>`, which is exactly what
  // /api/cron/reconcile compares against. Generated, never printed, and written
  // back to .env.local so a local run of the same route behaves identically.
  const cronSecret = env.get("CRON_SECRET");
  if (cronSecret) plan.set("CRON_SECRET", cronSecret);
  else if (args.cron) {
    const generated = randomBytes(32).toString("base64url");
    plan.set("CRON_SECRET", generated);
    if (!args.dryRun) appendFileSync(ENV_FILE, `\nCRON_SECRET=${generated}\n`);
    console.log("Generated CRON_SECRET (value not printed; appended to .env.local)");
  } else {
    console.log("CRON_SECRET absent — skip with --generate-cron-secret, or the reconcile cron 401s.");
  }

  const skipped = PASSTHROUGH.filter((name) => !env.get(name));
  if (skipped.length) console.log(`Not in .env.local, so NOT pushed: ${skipped.join(", ")}`);

  console.log(`\nTarget: ${args.target}${args.dryRun ? " (dry run)" : ""}`);
  let failures = 0;
  for (const [name, value] of plan) {
    if (args.dryRun) {
      console.log(`  would set  ${name}  (${SECRET_TYPE.has(name) ? "secret" : "config"})`);
      continue;
    }
    const result = push(name, value, args.target);
    if (result.ok) console.log(`  ✓ ${name}  (${result.type})`);
    else {
      failures++;
      console.log(`  ✗ ${name} — ${result.detail}`);
    }
  }

  console.log(
    failures
      ? `\n${failures} variable(s) failed. Nothing was printed; re-run after fixing the cause.`
      : `\nDone. ${plan.size} variable(s) set in ${args.target}. Redeploy for them to take effect.`,
  );
  process.exit(failures ? 1 : 0);
}

main();
