#!/usr/bin/env node
/**
 * Verify a migrated Supabase project over HTTP — no DATABASE_URL required.
 *
 *   npm run verify:remote
 *
 * `npm run db:verify` is stronger: it connects to Postgres and inspects
 * pg_catalog, grants, triggers and constraints directly. But it needs the
 * database password. When the schema was applied by pasting
 * `supabase/apply-all.sql` into the SQL editor, this script is the only check
 * available, and it is far better than assuming the paste worked.
 *
 * What it can prove over REST:
 *   - every required table exists and is exposed (no PGRST205)
 *   - the rate limiter function exists AND behaves (allows, then refuses)
 *   - settings and currencies were seeded
 *   - an anonymous client reads nothing from any financial table
 *   - an anonymous client cannot insert a ledger row or call a money function
 *
 * What it cannot, and says so rather than implying otherwise: trigger bodies,
 * constraint definitions, and function grants as Postgres sees them. Those are
 * covered by `db:verify` and by tests/sql/*.
 *
 * Uses NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SECRET_KEY. Prints no secrets.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MIGRATIONS_DIR, loadEnvLocal, migrationFiles } from "./lib/migrate.mjs";

loadEnvLocal();

const URL_BASE = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").replace(/\/$/, "");
const PUBLISHABLE = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "";
const SECRET = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

if (!URL_BASE || !PUBLISHABLE || !SECRET) {
  console.error(
    "\n  ✗ NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY and\n" +
      "    SUPABASE_SECRET_KEY are required.\n",
  );
  process.exit(1);
}

const results = [];
const record = (ok, name, detail) => {
  results.push({ ok, name, detail });
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? `  — ${detail}` : ""}`);
};
const skip = (name, why) => {
  results.push({ ok: null, name, detail: why });
  console.log(`  · ${name}  — skipped: ${why}`);
};

const adminHeaders = { apikey: SECRET, authorization: `Bearer ${SECRET}` };
const anonHeaders = { apikey: PUBLISHABLE };

async function rest(path, { role = "admin", method = "GET", body, headers = {} } = {}) {
  const res = await fetch(`${URL_BASE}/rest/v1${path}`, {
    method,
    headers: {
      ...(role === "admin" ? adminHeaders : anonHeaders),
      "content-type": "application/json",
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON error page */
  }
  return { status: res.status, json, text };
}

/* -------------------------------------------------------------------------- */

const WAIT = process.argv.includes("--wait");
const TIMEOUT_MS =
  Number((process.argv.find((a) => a.startsWith("--timeout=")) ?? "").split("=")[1] ?? 300) * 1000;

console.log("\n  TaskCash Pro — remote schema verification (HTTP only)\n");
console.log(`  project: ${URL_BASE.replace(/^https:\/\//, "")}\n`);

const REQUIRED_TABLES = [
  "profiles",
  "wallets",
  "wallet_transactions",
  "deposits",
  "withdrawals",
  "videos",
  "video_campaigns",
  "video_watch_sessions",
  "referrals",
  "referral_commissions",
  "notifications",
  "audit_logs",
  "fraud_events",
  "system_settings",
];

const COLUMN_CHECK = "the tables have the columns the app queries";

/**
 * Columns the application cannot work without.
 *
 * A table NAME is a weak signal: a project seeded with an earlier generation of
 * this schema has every table name and none of the right columns, so a
 * name-only check goes green on a database that cannot serve a single request.
 * These few columns are the load-bearing ones — `profiles.auth_user_id` is how
 * every session resolves its owner, and `wallet_transactions.direction` is how
 * the ledger is read.
 */
const REQUIRED_COLUMNS = {
  profiles: ["auth_user_id", "role", "risk_status"],
  wallets: ["available_balance", "locked_balance"],
  // The column is `type`. (The earlier list said `transaction_type`, which is
  // only ever a KEY in a SasaPay payload — src/lib/payments/sasapay/callback.ts
  // reads it from the provider's JSON, never from this table.) Correcting the
  // list here rather than "fixing" a database that was already right.
  wallet_transactions: ["type", "direction", "reference"],
  withdrawals: ["idempotency_key", "status"],
  deposits: ["merchant_reference", "provider_transaction_id"],
  system_settings: ["key", "value"],
};

/**
 * Ask PostgREST for exactly these columns. A missing one comes back as
 * `42703 column ... does not exist`, which is the precise fault we want to
 * name rather than infer.
 */
async function missingColumns() {
  const absent = [];
  for (const [table, columns] of Object.entries(REQUIRED_COLUMNS)) {
    const { status, json } = await rest(`/${table}?select=${columns.join(",")}&limit=1`);
    if (status === 200) continue;
    const message = json?.message ?? `http ${status}`;
    absent.push(`${table}.${message.replace(/^column .*?\.([a-z_]+) does not exist$/, "$1")}`);
  }
  return absent;
}

/** Names of the required tables that are not yet exposed. */
async function missingTables() {
  const absent = [];
  for (const table of REQUIRED_TABLES) {
    const { status, json } = await rest(`/${table}?select=*&limit=1`);
    const notFound = status === 404 && json?.code === "PGRST205";
    if (notFound) absent.push(table);
    else if (status >= 400 && status !== 401 && status !== 403) {
      absent.push(`${table} (http ${status})`);
    }
  }
  return absent;
}

console.log("  Tables\n");

/**
 * `--wait` exists so the SQL editor and this script can be used in either
 * order: start the watch, paste, run the query, and watch it go green.
 *
 * The wait must end only when the schema is USABLE — table names AND the
 * columns the app queries — not when the names appear. A project holding an
 * earlier generation of this schema already has every table name, so waiting on
 * names alone would return immediately and then report a schema that cannot
 * serve one request.
 */
async function probeSchema() {
  const tables = await missingTables();
  const columns = tables.length === 0 ? await missingColumns() : [];
  return { tables, columns, ready: tables.length === 0 && columns.length === 0 };
}

let state = await probeSchema();

if (WAIT && !state.ready) {
  const deadline = Date.now() + TIMEOUT_MS;
  process.stdout.write(`  waiting for a usable schema (up to ${Math.round(TIMEOUT_MS / 1000)}s)`);
  while (!state.ready && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    process.stdout.write(".");
    state = await probeSchema();
  }
  process.stdout.write(state.ready ? "  schema usable\n\n" : "  timed out\n\n");
}

const { tables: missing, columns: badColumns } = state;

record(
  missing.length === 0,
  `all ${REQUIRED_TABLES.length} required tables exist`,
  missing.length ? `missing: ${missing.join(", ")}` : null,
);

if (missing.length === 0) {
  record(
    badColumns.length === 0,
    COLUMN_CHECK,
    badColumns.length
      ? `missing/renamed: ${badColumns.join(", ")} — this project holds an INCOMPATIBLE earlier schema; see \`npm run db:reinit\``
      : null,
  );
}

if (missing.length > 0) {
  console.error(
    "\n  ✗ the schema is not applied. Apply it with `npm run db:migrate`, or paste\n" +
      "    supabase/apply-all.sql (from `npm run db:bundle`) into the SQL editor,\n" +
      "    then run this again.\n",
  );
  process.exit(1);
}

/* -------------------------------------------------------------------------- */
/* Coverage per migration file                                                */
/* -------------------------------------------------------------------------- */

/**
 * PostgREST's own OpenAPI document lists every table and every callable
 * function it knows about, in one request. That makes it the precise source of
 * truth for "what did the last apply actually create" — far better than
 * guessing, and it reads from the same schema cache the app queries through.
 */
async function openapiPaths() {
  const res = await fetch(`${URL_BASE}/rest/v1/`, { headers: adminHeaders });
  const spec = await res.json().catch(() => null);
  return Object.keys(spec?.paths ?? {});
}

const paths = await openapiPaths();
const liveTables = new Set(
  paths.filter((p) => p !== "/" && !p.startsWith("/rpc/")).map((p) => p.slice(1)),
);
const liveFunctions = new Set(paths.filter((p) => p.startsWith("/rpc/")).map((p) => p.slice(5)));

/**
 * Functions declared `returns trigger`.
 *
 * PostgREST never exposes these under /rpc/, so they can be perfectly present
 * in the database and still absent from the OpenAPI document this check reads.
 * Counting them as missing produced three false "not applied" verdicts — the
 * tell was that they were exactly the trigger functions, nothing else.
 *
 * They are not unverifiable, just not verifiable THIS way: they are proven
 * behaviourally instead — `handle_new_user` by registration creating a profile,
 * `touch_updated_at` by any UPDATE moving `updated_at`, `block_ledger_mutation`
 * by a refused ledger UPDATE, all of which `npm run test:e2e` and the SQL suite
 * exercise against the live database.
 */
function triggerFunctionNames(sql) {
  const names = new Set();
  const declaration = /create or replace function public\.([a-z_]+)/g;
  for (const match of sql.matchAll(declaration)) {
    const window = sql.slice(match.index, match.index + 400);
    if (/returns\s+trigger/i.test(window)) names.add(match[1]);
  }
  return names;
}

/**
 * Columns a migration adds with `alter table ... add column`, as {table, column}.
 *
 * Without these, a migration whose ENTIRE effect is adding columns reports a
 * vacuous tick: it declares no table and no function, so it has nothing to
 * check and is printed green whether or not it was ever run. `0012` is exactly
 * that shape — this script printed it "✓" without asking a single question about
 * it. A green line that cannot go red is worse than no line.
 */
function addedColumns(sql) {
  const out = [];
  for (const statement of sql.matchAll(/alter table public\.([a-z_]+)([^;]*);/g)) {
    const [, table, body] = statement;
    for (const column of body.matchAll(/add column if not exists ([a-z_]+)/g)) {
      out.push({ table, column: column[1] });
    }
  }
  return out;
}

/** Which of those columns PostgREST cannot select. A `42703` means absent. */
async function absentAddedColumns(wanted) {
  const absent = [];
  for (const { table, column } of wanted) {
    const { status } = await rest(`/${table}?select=${column}&limit=1`);
    if (status !== 200) absent.push(`${table}.${column}`);
  }
  return absent;
}

/* -------------------------------------------------------------------------- */
/* storage — the one object 0016 creates that PostgREST cannot see             */
/* -------------------------------------------------------------------------- */

console.log("\n  Storage\n");

/*
  Company picture rows point at files in a Storage bucket that migration 0016
  creates. The table coverage below proves the TABLE and says nothing at all
  about the bucket — yet the failure an operator actually hits is "bucket not
  found" during an upload, with every table present. Storage has its own API, so
  it is asked directly rather than inferred.

  Placed ABOVE the migration-coverage block on purpose: that block exits early
  when anything is unapplied, and the bucket is exactly what a half-migrated
  project needs told.
*/
const companyBucket = await fetch(`${URL_BASE}/storage/v1/bucket/company-images`, {
  headers: adminHeaders,
});
const companyBucketBody = companyBucket.ok ? await companyBucket.json().catch(() => null) : null;
record(
  companyBucket.ok,
  "the company-images storage bucket exists",
  companyBucket.ok
    ? `public: ${companyBucketBody?.public ?? "?"} — company image uploads land here`
    : `http ${companyBucket.status} (uploading a company picture will fail with "bucket not found")`,
);

console.log("  Coverage by migration file\n");

const incomplete = [];
const triggerFns = new Set();
for (const file of migrationFiles()) {
  const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
  const wantTables = [
    ...new Set([...sql.matchAll(/create table if not exists public\.([a-z_]+)/g)].map((m) => m[1])),
  ];
  const asTriggers = triggerFunctionNames(sql);
  for (const name of asTriggers) triggerFns.add(name);
  const wantFunctions = [
    ...new Set([...sql.matchAll(/create or replace function public\.([a-z_]+)/g)].map((m) => m[1])),
  ].filter((name) => !asTriggers.has(name));

  const wantColumns = addedColumns(sql);

  const missingTables = wantTables.filter((t) => !liveTables.has(t));
  const missingFunctions = wantFunctions.filter((f) => !liveFunctions.has(f));
  const missingAddedColumns = await absentAddedColumns(wantColumns);
  const complete =
    missingTables.length === 0 &&
    missingFunctions.length === 0 &&
    missingAddedColumns.length === 0;

  const parts = [];
  if (wantTables.length > 0) {
    parts.push(`tables ${wantTables.length - missingTables.length}/${wantTables.length}`);
  }
  if (wantFunctions.length > 0) {
    parts.push(`functions ${wantFunctions.length - missingFunctions.length}/${wantFunctions.length}`);
  }
  if (wantColumns.length > 0) {
    parts.push(`columns ${wantColumns.length - missingAddedColumns.length}/${wantColumns.length}`);
  }
  if (asTriggers.size > 0) {
    parts.push(`+${asTriggers.size} trigger fn (not exposed over REST)`);
  }

  console.log(`  ${complete ? "✓" : "✗"} ${file.padEnd(28)} ${parts.join("  ")}`);
  if (!complete) {
    incomplete.push(file);
    if (missingTables.length > 0) {
      console.log(`      missing tables:    ${missingTables.join(", ")}`);
    }
    if (missingFunctions.length > 0) {
      console.log(`      missing functions: ${missingFunctions.join(", ")}`);
    }
    if (missingAddedColumns.length > 0) {
      console.log(`      missing columns:   ${missingAddedColumns.join(", ")}`);
    }
  }
}
console.log("");
if (triggerFns.size > 0) {
  console.log(
    `  ${triggerFns.size} trigger function(s) — ${[...triggerFns].join(", ")}\n` +
      "  PostgREST does not expose `returns trigger` functions, so their presence cannot be\n" +
      "  read from here. Prove them behaviourally: `npm run test:e2e` registers an account,\n" +
      "  which requires handle_new_user to create the profile row.\n",
  );
}

if (incomplete.length > 0) {
  // The advice depends on WHY it is incomplete, and getting this wrong wastes a
  // round trip: a project holding an earlier generation has the right table
  // NAMES, so re-running cannot help — `create table if not exists` skips them
  // and every later statement fails on a column that was never added.
  const incompatible = results.some((r) => r.ok === false && r.name === COLUMN_CHECK);

  console.log(`  ${incomplete.length} migration file(s) are not fully applied: ${incomplete.join(", ")}\n`);
  if (incompatible) {
    console.log(
      "  Re-running the migrations will NOT fix this. The table names already exist with\n" +
        "  different columns, so `create table if not exists` skips them and the old shape\n" +
        "  survives. This project holds an incompatible earlier schema and has to be reset:\n\n" +
        "      npm run db:reinit     # guarded reset + the full bundle, one paste, one transaction\n\n" +
        "  Read supabase/reset-incompatible-schema.sql first: it refuses to run at all if the\n" +
        "  project holds an account or a user row, so it cannot destroy real data.\n",
    );
  } else {
    console.log(
      "  Re-run them in order. Every file is safe to re-run: tables use `if not exists`,\n" +
        "  functions use `create or replace`, policies and triggers are dropped first, and\n" +
        "  the seed rows upsert on conflict. Run them one at a time so the first error is\n" +
        "  visible instead of hidden inside a 2,500-line paste.\n",
    );
  }
  if (!process.argv.includes("--partial-ok")) process.exit(1);
}

/* -------------------------------------------------------------------------- */
/* Rate limiter: exists AND behaves                                            */
/* -------------------------------------------------------------------------- */

console.log("\n  Rate limiter\n");

const bucket = "verify:selftest";
const identifier = `probe-${Date.now()}`;
const hit = (limit) =>
  rest("/rpc/rate_limit_hit", {
    method: "POST",
    body: {
      p_bucket: bucket,
      p_identifier: identifier,
      p_limit: limit,
      p_window_seconds: 60,
    },
  });

const first = await hit(1);
const fnMissing = first.status === 404 && first.json?.code === "PGRST202";
record(!fnMissing, "public.rate_limit_hit exists", fnMissing ? "PGRST202 — function not found" : `http ${first.status}`);

if (!fnMissing) {
  record(
    first.status === 200 && first.json === true,
    "the first request in a window is allowed",
    `returned ${JSON.stringify(first.json)}`,
  );
  const second = await hit(1);
  record(
    second.status === 200 && second.json === false,
    "the next request in the same window is refused",
    `returned ${JSON.stringify(second.json)}`,
  );
  console.log(
    `    (this wrote one counter row to public.rate_limits for bucket "${bucket}" — not financial data)`,
  );
}

/* -------------------------------------------------------------------------- */
/* Seeds                                                                       */
/* -------------------------------------------------------------------------- */

console.log("\n  Seed data\n");

const settings = await rest("/system_settings?select=key&limit=200");
record(
  settings.status === 200 && Array.isArray(settings.json) && settings.json.length >= 20,
  "system_settings seeded",
  Array.isArray(settings.json) ? `${settings.json.length} rows` : `http ${settings.status}`,
);

const currencies = await rest("/currencies?select=code,min_withdrawal&limit=50");
const kes = Array.isArray(currencies.json)
  ? currencies.json.find((c) => c.code === "KES")
  : null;
record(
  Boolean(kes),
  "KES is configured as a currency",
  kes ? `min withdrawal ${kes.min_withdrawal}` : `http ${currencies.status}`,
);

/* -------------------------------------------------------------------------- */
/* RLS, from an anonymous client                                              */
/* -------------------------------------------------------------------------- */

console.log("\n  Row level security (anonymous client, publishable key only)\n");

for (const table of ["profiles", "wallets", "wallet_transactions", "deposits", "withdrawals", "notifications"]) {
  const { status, json } = await rest(`/${table}?select=*&limit=5`, { role: "anon" });
  const exposed = Array.isArray(json) && json.length > 0;
  record(
    !exposed,
    `anonymous client sees nothing in ${table}`,
    exposed ? `LEAKED ${json.length} row(s)` : `http ${status}`,
  );
}

const anonInsert = await rest("/wallet_transactions", {
  role: "anon",
  method: "POST",
  headers: { prefer: "return=representation" },
  body: {
    user_id: "00000000-0000-0000-0000-000000000000",
    wallet_id: "00000000-0000-0000-0000-000000000000",
    type: "DEPOSIT",
    amount: 1,
    currency: "KES",
    status: "COMPLETED",
    reference: `verify-remote-${Date.now()}`,
  },
});
record(
  anonInsert.status >= 400,
  "anonymous client cannot insert a ledger entry",
  `http ${anonInsert.status}`,
);

const anonRpc = await rest("/rpc/wallet_post", {
  role: "anon",
  method: "POST",
  body: {
    p_user_id: "00000000-0000-0000-0000-000000000000",
    p_type: "DEPOSIT",
    p_amount: 1,
    p_status: "COMPLETED",
    p_reference: `verify-remote-${Date.now()}`,
  },
});
record(
  anonRpc.status !== 200,
  "anonymous client cannot call the money function",
  `http ${anonRpc.status}`,
);

/* -------------------------------------------------------------------------- */

console.log("\n  Not checkable over HTTP (needs DATABASE_URL → `npm run db:verify`)\n");
skip("ledger immutability trigger body", "pg_catalog is not exposed through PostgREST");
skip("non-negative balance constraints", "covered by tests/sql/10_ledger.sql on a real Postgres");
skip("function grants for anon/authenticated", "inferred above from refused calls; not read from the catalog");

const failed = results.filter((r) => r.ok === false);
console.log(
  `\n${"─".repeat(72)}\n  ${results.filter((r) => r.ok === true).length} passed, ${failed.length} failed, ${results.filter((r) => r.ok === null).length} skipped\n`,
);
if (failed.length > 0) {
  console.log("  Failures:");
  for (const f of failed) console.log(`    ✗ ${f.name}  ${f.detail ?? ""}`);
  console.log("");
}
process.exit(failed.length === 0 ? 0 : 1);
