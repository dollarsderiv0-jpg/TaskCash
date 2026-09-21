#!/usr/bin/env node
/**
 * Apply a SQL file to a Supabase project through the Management API.
 *
 *   npm run db:push-sql                       # sends supabase/reinit.sql if present, else apply-all.sql
 *   npm run db:push-sql -- --file=supabase/apply-all.sql
 *   npm run db:push-sql -- --dry-run          # show what would be sent, send nothing
 *   npm run db:push-sql -- --check-token      # report what the token can do, send nothing
 *
 * Why this exists: the SQL editor is the only route when `DATABASE_URL` is
 * unavailable, but it requires a human to copy a 2,500-line file into a
 * clipboard and paste it into a browser. That step failed repeatedly here — the
 * clipboard was overwritten by an unrelated copy each time, so what arrived in
 * the editor was a URL or a shell command. This sends the file over HTTPS
 * instead, with no clipboard, no browser, and no database password.
 *
 * Requires:
 *   SUPABASE_ACCESS_TOKEN   a personal access token (`sbp_…`) with `database_write`
 *                           Account → Access Tokens in the Supabase dashboard.
 *                           Set it with `npm run env:set` (masked), never in chat.
 *   NEXT_PUBLIC_SUPABASE_URL  the project it targets — the ref is derived from it,
 *                             so this cannot be pointed at another project by typo.
 *
 * SECURITY: a personal access token is account-wide — it can create and delete
 * projects, not just run SQL. It is read from the environment, never printed,
 * never sent anywhere except api.supabase.com, and the script refuses to run
 * against a non-Supabase URL. Rotate or delete it when you are finished.
 *
 * The token is NOT part of the application's configuration and nothing in
 * src/ reads it. It exists for this script alone.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, loadEnvLocal } from "./lib/migrate.mjs";

loadEnvLocal();

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const CHECK_ONLY = args.includes("--check-token");
const FORCE = args.includes("--force");
const FILE_ARG = args.find((a) => a.startsWith("--file="))?.split("=").slice(1).join("=") ?? null;

const TOKEN = process.env.SUPABASE_ACCESS_TOKEN ?? "";
const URL_BASE = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").replace(/\/$/, "");

if (!TOKEN) {
  console.error(
    "\n  ✗ SUPABASE_ACCESS_TOKEN is not set.\n\n" +
      "    Create one at https://supabase.com/dashboard/account/tokens\n" +
      "    (permission needed: database_write), then:  npm run env:set\n\n" +
      "    A personal access token is account-wide — treat it as a secret, and\n" +
      "    delete it in the dashboard when you are done.\n",
  );
  process.exit(2);
}

const ref = URL_BASE.match(/^https:\/\/([a-z0-9]+)\.supabase\.co$/)?.[1] ?? null;
if (!ref) {
  console.error(
    `\n  ✗ NEXT_PUBLIC_SUPABASE_URL is missing or is not a Supabase project URL.\n` +
      `    Got: ${URL_BASE ? URL_BASE.replace(/\/\/.*@/, "//") : "(empty)"}\n`,
  );
  process.exit(2);
}

/** The single endpoint both the probe and the apply use. */
const QUERY_URL = `https://api.supabase.com/v1/projects/${ref}/database/query`;

/* -------------------------------------------------------------------------- */
/* what can this token actually do?                                           */
/* -------------------------------------------------------------------------- */

/**
 * Ask the endpoint which role it will run our SQL as.
 *
 * POST /database/query accepts a token scoped `database_read` OR `database_write`
 * — that is Supabase's own reference for the endpoint — and a read-only one is
 * not refused. It is executed as `supabase_read_only_user`, a role with no CREATE
 * privilege in any schema, so the first statement needing a write fails with:
 *
 *     25006: cannot execute CREATE FUNCTION in a read-only transaction
 *
 * That error names neither the token nor the fix, and it arrives only after the
 * whole file has been sent — which makes an under-scoped token look like a broken
 * migration file. (There is a separate `/database/query/read-only` path and it
 * runs as the same role, so the wrong path is not the explanation.)
 *
 * This asks the question before anything is sent.
 */
async function probeToken() {
  try {
    const response = await fetch(QUERY_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        query:
          "select current_user::text as role, " +
          "has_schema_privilege(current_user, 'public', 'create') as can_create",
      }),
    });
    const text = await response.text();

    if (response.status === 401 || response.status === 403) {
      return { verdict: "rejected", detail: `http ${response.status} — ${text.slice(0, 300)}` };
    }
    if (!response.ok) {
      return { verdict: "unknown", detail: `http ${response.status} — ${text.slice(0, 300)}` };
    }

    let row = null;
    try {
      const parsed = JSON.parse(text);
      row = Array.isArray(parsed) ? parsed[0] : parsed;
    } catch {
      /* not JSON — reported as inconclusive below */
    }
    if (!row || typeof row.can_create !== "boolean") {
      return { verdict: "unknown", detail: text.slice(0, 200) || "(empty response)" };
    }

    return {
      verdict: row.can_create ? "write" : "read-only",
      role: row.role,
      detail: `runs as ${row.role}, CREATE on public: ${row.can_create}`,
    };
  } catch (error) {
    return { verdict: "unknown", detail: `could not reach api.supabase.com: ${error.message}` };
  }
}

const READ_ONLY_ADVICE = [
  "    The token was accepted, but it runs as a read-only role: every statement",
  "    that needs a write fails with \"25006: cannot execute … in a read-only",
  "    transaction\". Its scope is Database: Read — it needs Read-write.",
  "",
  "      https://supabase.com/dashboard/account/tokens    → Database: Read-write",
  "      npm run env:set -- --only=SUPABASE_ACCESS_TOKEN",
  "",
  "    Read alone is enough to reach this endpoint, which is why this looks like",
  "    broken SQL instead of a credential problem.",
  "",
  "    A DATABASE_URL (Session pooler URI) also works and needs no token at all:",
  "    set it, then run `npm run db:migrate` — the token's scope never comes up.",
].join("\n");

if (CHECK_ONLY) {
  console.log("\n  TaskCash Pro — what can SUPABASE_ACCESS_TOKEN do?\n");
  console.log(`  target : ${URL_BASE.replace(/^https:\/\//, "")}  (ref ${ref})\n`);

  const probe = await probeToken();

  if (probe.verdict === "write") {
    console.log(`  ✓ write-capable — ${probe.detail}\n`);
    process.exit(0);
  }
  if (probe.verdict === "read-only") {
    console.error(`  ✗ READ-ONLY — ${probe.detail}\n`);
    console.error(`${READ_ONLY_ADVICE}\n`);
    process.exit(3);
  }
  if (probe.verdict === "rejected") {
    console.error(`  ✗ the token was rejected — ${probe.detail}\n`);
    console.error("    A 401/403 here is the token itself, not its scope: wrong,\n    expired, or revoked.\n");
    process.exit(1);
  }
  console.error(`  ? could not be determined — ${probe.detail}\n`);
  console.error("    The check is inconclusive, so nothing can be said either way.\n");
  process.exit(4);
}

/* -------------------------------------------------------------------------- */

let file = FILE_ARG ? join(ROOT, FILE_ARG) : null;
if (!file) {
  const reinit = join(ROOT, "supabase", "reinit.sql");
  const bundle = join(ROOT, "supabase", "apply-all.sql");
  file = existsSync(reinit) ? reinit : bundle;
  if (!FILE_ARG && !existsSync(file)) {
    console.error(
      "\n  ✗ neither supabase/reinit.sql nor supabase/apply-all.sql exists.\n" +
        "    Generate one first:  npm run db:reinit   (or npm run db:bundle)\n",
    );
    process.exit(2);
  }
}

if (!existsSync(file)) {
  console.error(`\n  ✗ ${file} does not exist.\n`);
  process.exit(2);
}

const sql = readFileSync(file, "utf8");
const lines = sql.split("\n").length;
const guard = sql.includes("REFUSING TO RESET");

console.log("\n  TaskCash Pro — push SQL via the Management API\n");
console.log(`  target : ${URL_BASE.replace(/^https:\/\//, "")}  (ref ${ref})`);
console.log(`  file   : ${file.slice(ROOT.length + 1)}`);
console.log(`  size   : ${lines} lines, ${Math.round(sql.length / 1024)} KB`);
console.log(`  guard  : ${guard ? "present — the script refuses if the project holds accounts or user rows" : "none in this file"}`);

if (DRY_RUN) {
  console.log("\n  · dry run: nothing was sent.\n");
  process.exit(0);
}

/*
  Refuse before sending when the token demonstrably cannot write. A read-only
  token produces a Postgres error naming whichever statement came first — the
  wrong file to go and read — after the whole file has travelled. `--force`
  exists because this probe is an inference about the endpoint: if it is ever
  wrong, an operator needs a way past it.
*/
const probe = await probeToken();
if (probe.verdict === "write") {
  console.log(`  token  : write-capable (${probe.detail})`);
} else if (probe.verdict === "read-only" && !FORCE) {
  console.error(`\n  ✗ not sending: the token is read-only — ${probe.detail}\n`);
  console.error(`${READ_ONLY_ADVICE}\n`);
  process.exit(3);
} else if (probe.verdict === "rejected" && !FORCE) {
  console.error(`\n  ✗ not sending: the token was rejected — ${probe.detail}\n`);
  process.exit(1);
} else if (probe.verdict === "unknown") {
  console.log(`  token  : could not be checked (${probe.detail}) — sending anyway`);
} else {
  console.log(`  token  : ${probe.verdict} (${probe.detail}) — continuing, --force was given`);
}

const started = Date.now();
let response;
try {
  response = await fetch(QUERY_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ query: sql }),
  });
} catch (error) {
  console.error(`\n  ✗ could not reach api.supabase.com: ${error.message}\n`);
  process.exit(1);
}

const text = await response.text();
const elapsed = ((Date.now() - started) / 1000).toFixed(1);

if (!response.ok) {
  // The API returns the Postgres error verbatim. Show it in full: the statement
  // and the message are the whole point, and neither is a secret.
  console.error(`\n  ✗ the query was rejected — http ${response.status} after ${elapsed}s\n`);
  console.error(`    ${text.slice(0, 2000)}\n`);
  if (response.status === 401 || response.status === 403) {
    console.error(
      "    A 401/403 here is the token, not the SQL: either it is wrong, or it lacks\n" +
        "    the database_write permission.\n",
    );
  }
  process.exit(1);
}

let body = null;
try {
  body = text ? JSON.parse(text) : null;
} catch {
  /* not JSON — fine, the 2xx status is the signal */
}

console.log(`\n  ✓ accepted — http ${response.status} after ${elapsed}s`);
console.log(`    response: ${body === null ? text.slice(0, 200) || "(empty)" : JSON.stringify(body).slice(0, 200)}`);
console.log("\n  Verify what landed (needs no password, and no token):");
console.log("      npm run verify:remote\n");
