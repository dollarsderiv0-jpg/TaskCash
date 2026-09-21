#!/usr/bin/env node
/**
 * Configure real SMTP delivery and the branded email templates on the Supabase
 * project, from environment variables — no vendor is hardcoded, and no
 * credential is ever printed or committed.
 *
 *   npm run smtp:configure -- --check      # read the project's current state
 *   npm run smtp:configure -- --dry-run    # show exactly what would be sent
 *   npm run smtp:configure                 # apply
 *
 * Why a script rather than the dashboard: the auth settings are project state,
 * and state that is only ever set by hand cannot be reproduced, reviewed, or
 * restored after a mistake. `--check` after applying is what proves it landed.
 *
 * Requires SUPABASE_ACCESS_TOKEN (a personal access token with `auth_config_write`)
 * and NEXT_PUBLIC_SUPABASE_URL — the ref is derived from the URL, so this cannot
 * be pointed at another project by typo.
 *
 * What it sets, and the exact field names the Management API uses:
 *   smtp_host, smtp_port, smtp_user, smtp_pass, smtp_admin_email, smtp_sender_name
 *   rate_limit_email_sent   (the project's own cap — 2 by default, which is a
 *                            development placeholder and throttles real signups)
 *   mailer_autoconfirm      (forced back to false: verification must not be off)
 *   mailer_subjects_*  and  mailer_templates_*_content, from emails/*.html
 *
 * SECURITY: the password is read from the environment, sent only to
 * api.supabase.com, never logged, and never written to a file. It is not part of
 * the application's configuration — nothing in src/ reads SMTP_* — because
 * Supabase Auth is what sends these emails, not the app.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ROOT, loadEnvLocal } from "./lib/migrate.mjs";

loadEnvLocal();

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const CHECK = args.includes("--check");

const TOKEN = process.env.SUPABASE_ACCESS_TOKEN ?? "";
const URL_BASE = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").replace(/\/$/, "");
const ref = URL_BASE.match(/^https:\/\/([a-z0-9]+)\.supabase\.co$/)?.[1] ?? null;

const CONFIG_URL = ref ? `https://api.supabase.com/v1/projects/${ref}/config/auth` : null;

/* -------------------------------------------------------------------------- */
/* `--check`: read the project, print the state, exit                       */
/* -------------------------------------------------------------------------- */

if (CHECK) {
  if (!TOKEN || !CONFIG_URL) {
    console.error("\n  ✗ SUPABASE_ACCESS_TOKEN and NEXT_PUBLIC_SUPABASE_URL are both required.\n");
    process.exit(2);
  }
  const response = await fetch(CONFIG_URL, { headers: { authorization: `Bearer ${TOKEN}` } });
  if (!response.ok) {
    console.error(`\n  ✗ could not read the auth config — http ${response.status}\n`);
    process.exit(1);
  }
  const config = await response.json();

  const configured = (value) => (value === null || value === undefined || value === "" ? "NOT SET" : "set");
  // Never print smtp_pass itself — only whether it is present.
  const rows = [
    ["smtp_host", config.smtp_host ?? "NOT SET"],
    ["smtp_port", config.smtp_port ?? "NOT SET"],
    ["smtp_user", configured(config.smtp_user)],
    ["smtp_pass", configured(config.smtp_pass)],
    ["smtp_admin_email", config.smtp_admin_email ?? "NOT SET"],
    ["smtp_sender_name", config.smtp_sender_name ?? "NOT SET"],
    ["mailer_autoconfirm", String(config.mailer_autoconfirm)],
    ["rate_limit_email_sent", String(config.rate_limit_email_sent)],
    ["mailer_subjects_confirmation", config.mailer_subjects_confirmation ?? "NOT SET"],
    ["mailer_subjects_recovery", config.mailer_subjects_recovery ?? "NOT SET"],
  ];

  console.log(`\n  Supabase auth email configuration — ${ref}\n`);
  for (const [key, value] of rows) console.log(`    ${key.padEnd(32)} ${value}`);

  const branding = typeof config.mailer_templates_confirmation_content === "string"
    && config.mailer_templates_confirmation_content.includes("TASKCASH PRO");
  console.log(`    ${"branded confirmation template".padEnd(32)} ${branding ? "yes" : "no — still the Supabase default"}`);

  const usingCustomSmtp = Boolean(config.smtp_host);
  const verificationOn = config.mailer_autoconfirm === false;
  console.log(
    `\n  ${usingCustomSmtp && verificationOn ? "✓" : "✗"} ` +
      `${usingCustomSmtp ? "custom SMTP configured" : "NO custom SMTP — signup email uses the built-in service (a few per hour)"}, ` +
      `${verificationOn ? "verification required" : "AUTOCONFIRM IS ON — accounts are trusted without verification"}\n`,
  );
  process.exit(usingCustomSmtp && verificationOn ? 0 : 1);
}

/* -------------------------------------------------------------------------- */
/* Configure                                                                   */
/* -------------------------------------------------------------------------- */

const SMTP = {
  host: process.env.SMTP_HOST ?? "",
  port: process.env.SMTP_PORT ?? "",
  user: process.env.SMTP_USERNAME ?? "",
  pass: process.env.SMTP_PASSWORD ?? "",
  from: process.env.SMTP_FROM_EMAIL ?? "",
  name: process.env.SMTP_FROM_NAME ?? "TaskCash Pro",
  rateLimit: process.env.SMTP_RATE_LIMIT_EMAILS ?? "",
};

const missing = Object.entries({
  SMTP_HOST: SMTP.host,
  SMTP_PORT: SMTP.port,
  SMTP_USERNAME: SMTP.user,
  SMTP_PASSWORD: SMTP.pass,
  SMTP_FROM_EMAIL: SMTP.from,
})
  .filter(([, value]) => !value)
  .map(([key]) => key);

if (missing.length > 0) {
  console.error(
    `\n  ✗ SMTP is not configured: ${missing.join(", ")}\n\n` +
      "    Set these in .env.local (see .env.example), then re-run. Use the dashboard\n" +
      "    sign-up for whichever transactional provider you chose — the values are\n" +
      "    standard SMTP, so any of Resend, Postmark, Brevo, Mailgun, SES or SendGrid\n" +
      "    works without changing this script.\n",
  );
  process.exit(2);
}

if (!TOKEN || !CONFIG_URL) {
  console.error("\n  ✗ SUPABASE_ACCESS_TOKEN and NEXT_PUBLIC_SUPABASE_URL are both required.\n");
  process.exit(2);
}

const port = Number(SMTP.port);
if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  console.error(`\n  ✗ SMTP_PORT is not a valid port: ${SMTP.port}\n`);
  process.exit(2);
}
if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(SMTP.from)) {
  console.error(`\n  ✗ SMTP_FROM_EMAIL does not look like an address: ${SMTP.from}\n`);
  process.exit(2);
}

/* Templates live as real files so they can be previewed and reviewed. */
const EMAILS_DIR = join(ROOT, "emails");
const TEMPLATE_FILES = {
  confirmation: "confirmation.html",
  recovery: "recovery.html",
};
const TEMPLATE_SUBJECTS = {
  confirmation: "Confirm your TaskCash Pro email address",
  recovery: "Reset your TaskCash Pro password",
};

const templates = {};
for (const [key, file] of Object.entries(TEMPLATE_FILES)) {
  const path = join(EMAILS_DIR, file);
  if (!existsSync(path)) {
    console.error(`\n  ✗ missing template: emails/${file}\n`);
    process.exit(2);
  }
  const html = readFileSync(path, "utf8");
  // Supabase substitutes these; a template that lost them would send an email
  // with no working link, so refuse rather than push a broken one.
  if (!html.includes("{{ .ConfirmationURL }}")) {
    console.error(`\n  ✗ emails/${file} has no {{ .ConfirmationURL }} placeholder.\n`);
    process.exit(2);
  }
  templates[key] = html;
}

const body = {
  smtp_host: SMTP.host,
  smtp_port: port,
  smtp_user: SMTP.user,
  smtp_pass: SMTP.pass,
  smtp_admin_email: SMTP.from,
  smtp_sender_name: SMTP.name,
  // Verification must be ON in any environment that sends real email.
  mailer_autoconfirm: false,
  mailer_subjects_confirmation: TEMPLATE_SUBJECTS.confirmation,
  mailer_subjects_recovery: TEMPLATE_SUBJECTS.recovery,
  mailer_templates_confirmation_content: templates.confirmation,
  mailer_templates_recovery_content: templates.recovery,
};

if (SMTP.rateLimit) {
  const limit = Number(SMTP.rateLimit);
  if (!Number.isInteger(limit) || limit < 1) {
    console.error(`\n  ✗ SMTP_RATE_LIMIT_EMAILS is not a positive integer: ${SMTP.rateLimit}\n`);
    process.exit(2);
  }
  body.rate_limit_email_sent = limit;
}

console.log("\n  TaskCash Pro — configure SMTP and email templates\n");
console.log(`  project : ${ref}`);
console.log(`  host    : ${SMTP.host}:${port}`);
console.log(`  user    : ${SMTP.user.length} characters (not printed)`);
console.log(`  pass    : ${SMTP.pass.length} characters (not printed)`);
console.log(`  from    : ${SMTP.name} <${SMTP.from}>`);
console.log(`  emails  : ${readdirSync(EMAILS_DIR).filter((f) => f.endsWith(".html")).join(", ")}`);
console.log(`  rate    : ${body.rate_limit_email_sent ?? "(left unchanged)"} auth emails/hour`);
console.log("  autoconfirm -> false (verification required)\n");

if (DRY_RUN) {
  console.log("  fields that would be sent:");
  for (const key of Object.keys(body).sort()) {
    const value = key === "smtp_pass" ? `${String(body[key]).length} characters` : JSON.stringify(body[key]).slice(0, 72);
    console.log(`    ${key.padEnd(42)} = ${value}`);
  }
  console.log("\n  · dry run: nothing was sent.\n");
  process.exit(0);
}

const response = await fetch(CONFIG_URL, {
  method: "PATCH",
  headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
  body: JSON.stringify(body),
});

if (!response.ok) {
  const text = await response.text();
  console.error(`\n  ✗ the auth config was rejected — http ${response.status}\n`);
  console.error(`    ${text.slice(0, 1200)}\n`);
  if (response.status === 401 || response.status === 403) {
    console.error("    A 401/403 here is the token, not the settings: it needs auth_config_write.\n");
  }
  process.exit(1);
}

console.log(`  ✓ applied — http ${response.status}`);
console.log("\n  Verify it landed (never prints the password):");
console.log("      npm run smtp:configure -- --check\n");
console.log("  Then send a real one: register an account or use /forgot-password.\n");
