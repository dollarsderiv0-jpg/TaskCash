#!/usr/bin/env node
/**
 * Read-only verification of a TaskCash Pro database.
 *
 *   node scripts/verify-backend.mjs
 *
 * Requires DATABASE_URL in the environment or in .env.local.
 *
 * This checks the properties that make the money safe, not cosmetics. It never
 * writes anything. A non-zero exit code means at least one check failed.
 *
 * Note on grants: in Supabase the anon/authenticated roles often hold INSERT/
 * UPDATE/DELETE grants on public tables by default. That is not by itself a
 * vulnerability — RLS is the boundary. What must NOT exist is a permissive
 * policy allowing a client to write to a financial table. That is what this
 * script asserts.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadEnvLocal() {
  const file = join(ROOT, ".env.local");
  if (!existsSync(file)) return;
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
}

loadEnvLocal();

const REQUIRED_TABLES = [
  "profiles",
  "wallets",
  "wallet_transactions",
  "deposits",
  "withdrawals",
  "video_campaigns",
  "videos",
  "video_watch_sessions",
  "referrals",
  "referral_commissions",
  "notifications",
  "audit_logs",
  "fraud_events",
  "system_settings",
  "currencies",
];

const REQUIRED_FUNCTIONS = [
  "wallet_post",
  "deposit_credit",
  "deposit_fail",
  "withdrawal_reserve",
  "withdrawal_release",
  "withdrawal_complete",
  "video_start",
  "video_progress",
  "video_complete_session",
  "referral_qualify",
  "admin_adjust_wallet",
  "write_audit",
  "notify_user",
];

/** Tables a client must never be able to write to, whatever the grants say. */
const CLIENT_READ_ONLY = [
  "profiles",
  "wallets",
  "wallet_transactions",
  "deposits",
  "withdrawals",
  "video_watch_sessions",
  "referrals",
  "referral_commissions",
  "notifications",
  "audit_logs",
  "fraud_events",
  "system_settings",
];

const results = [];

function record(name, ok, detail = "") {
  results.push({ name, ok, detail });
  const mark = ok ? "  ✓" : "  ✗";
  console.log(`${mark} ${name}${detail ? ` — ${detail}` : ""}`);
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("\n  ✗ DATABASE_URL is not set (put it in .env.local)\n");
  process.exit(1);
}

const client = new pg.Client({
  connectionString: databaseUrl,
  ssl: { rejectUnauthorized: false },
});

async function main() {
  await client.connect();
  const { rows: id } = await client.query("select current_database() as db");
  console.log(`\nVerifying ${id[0].db}\n`);

  /* ---------------------------------------------------------------------- */
  /* 1. Tables exist and have RLS                                           */
  /* ---------------------------------------------------------------------- */
  console.log("Tables and RLS");

  const { rows: tables } = await client.query(
    `select c.relname as name, c.relrowsecurity as rls, c.relforcerowsecurity as force_rls,
            coalesce(s.n_live_tup, 0) as rows
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       left join pg_stat_user_tables s on s.relid = c.oid
      where n.nspname = 'public' and c.relkind = 'r'`,
  );
  const byName = new Map(tables.map((t) => [t.name, t]));

  const missing = REQUIRED_TABLES.filter((t) => !byName.has(t));
  record("all required tables exist", missing.length === 0, missing.join(", ") || `${tables.length} tables`);

  const noRls = REQUIRED_TABLES.filter((t) => byName.has(t) && !byName.get(t).rls);
  record("row level security enabled on every app table", noRls.length === 0, noRls.join(", "));

  /* ---------------------------------------------------------------------- */
  /* 2. No permissive write policy on a financial table                      */
  /* ---------------------------------------------------------------------- */
  console.log("\nPolicies");

  const { rows: policies } = await client.query(
    `select tablename, policyname, cmd, roles::text as roles, qual
       from pg_policies where schemaname = 'public'`,
  );

  const writes = policies.filter(
    (p) =>
      CLIENT_READ_ONLY.includes(p.tablename) &&
      p.cmd !== "SELECT" &&
      // A policy restricted to service_role cannot be reached by a client.
      !(Array.isArray(p.roles) && p.roles.length === 1 && p.roles[0] === "service_role"),
  );
  record(
    "no client-writable policy on financial tables",
    writes.length === 0,
    writes.map((p) => `${p.tablename}:${p.cmd}`).join(", ") || `${policies.length} policies`,
  );

  const writeSelect = policies.filter(
    (p) => CLIENT_READ_ONLY.includes(p.tablename) && p.cmd === "SELECT",
  );
  record("select policies present for own-row reads", writeSelect.length > 0, `${writeSelect.length} select policies`);

  const permissive = policies.filter(
    (p) => CLIENT_READ_ONLY.includes(p.tablename) && (!p.qual || p.qual.trim() === "true"),
  );
  record("no unrestricted USING (true) policy on financial tables", permissive.length === 0, permissive.map((p) => p.policyname).join(", "));

  /* ---------------------------------------------------------------------- */
  /* 3. Ledger immutability                                                  */
  /* ---------------------------------------------------------------------- */
  console.log("\nLedger integrity");

  const { rows: txTriggers } = await client.query(
    `select tgname from pg_trigger
      where tgrelid = 'public.wallet_transactions'::regclass and not tgisinternal`,
  );
  record(
    "wallet_transactions has an immutability trigger",
    txTriggers.some((t) => /block|immutab|ledger/i.test(t.tgname)),
    txTriggers.map((t) => t.tgname).join(", ") || "none",
  );

  const { rows: uniqueRefs } = await client.query(
    `select conname from pg_constraint
      where conrelid = 'public.wallet_transactions'::regclass and contype = 'u'`,
  );
  record("ledger reference is unique", uniqueRefs.length > 0, uniqueRefs.map((c) => c.conname).join(", "));

  /* ---------------------------------------------------------------------- */
  /* 4. Functions exist and are server-only                                  */
  /* ---------------------------------------------------------------------- */
  console.log("\nFunctions");

  const { rows: fns } = await client.query(
    `select p.proname as name, p.prosecdef as security_definer,
            coalesce(array_to_string(p.proconfig, ','), '') as config
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'`,
  );
  const fnByName = new Map(fns.map((f) => [f.name, f]));

  const missingFns = REQUIRED_FUNCTIONS.filter((f) => !fnByName.has(f));
  record("money functions exist", missingFns.length === 0, missingFns.join(", ") || `${fns.length} functions`);

  const notDefiner = REQUIRED_FUNCTIONS.filter(
    (f) => fnByName.has(f) && !fnByName.get(f).security_definer,
  );
  record("money functions are SECURITY DEFINER", notDefiner.length === 0, notDefiner.join(", "));

  const noSearchPath = REQUIRED_FUNCTIONS.filter(
    (f) => fnByName.has(f) && !fnByName.get(f).config.includes("search_path"),
  );
  record("money functions pin search_path", noSearchPath.length === 0, noSearchPath.join(", "));

  const { rows: reachable } = await client.query(
    `select p.proname as name, r.rolname as role
       from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
       cross join (values ('anon'), ('authenticated')) as r(rolname)
      where n.nspname = 'public'
        and p.proname = any($1::text[])
        and has_function_privilege(r.rolname, p.oid, 'EXECUTE')`,
    [REQUIRED_FUNCTIONS],
  );
  record(
    "clients cannot EXECUTE the money functions",
    reachable.length === 0,
    reachable.map((r) => `${r.name}/${r.role}`).join(", ") || "none",
  );

  /* ---------------------------------------------------------------------- */
  /* 5. Reference data                                                       */
  /* ---------------------------------------------------------------------- */
  console.log("\nReference data");

  const { rows: currencies } = await client.query(
    "select code, enabled, min_withdrawal from public.currencies order by code",
  );
  const activeCurrencies = currencies.filter((c) => c.enabled);
  record(
    "at least one enabled currency",
    activeCurrencies.length > 0,
    activeCurrencies.map((c) => `${c.code} (min ${c.min_withdrawal})`).join(", "),
  );

  const { rows: settings } = await client.query("select count(*)::int as n from public.system_settings");
  record("system settings seeded", settings[0].n > 0, `${settings[0].n} keys`);

  const { rows: migrations } = await client.query(
    "select count(*)::int as n from public.taskcash_migrations",
  );
  record("migration ledger present", migrations[0].n > 0, `${migrations[0].n} migrations recorded`);

  /* ---------------------------------------------------------------------- */
  console.log("\nRow counts");
  for (const table of REQUIRED_TABLES) {
    const row = byName.get(table);
    if (row) console.log(`    ${table.padEnd(24)} ${row.rows}`);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(
    `\n${failed.length === 0 ? "All checks passed" : `${failed.length} check(s) FAILED`} — ${results.length} total\n`,
  );

  await client.end();
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch(async (error) => {
  await client.end().catch(() => {});
  console.error(`\n  ✗ ${error.message}\n`);
  process.exit(1);
});
