#!/usr/bin/env node
/**
 * Run the TaskCash Pro money invariant suite.
 *
 *   npm run test:money                 # scratch database, dropped afterwards
 *   npm run test:money -- --mode=transaction
 *   npm run test:money -- --file=20_withdrawals.sql
 *   npm run test:money -- --keep       # leave the scratch database for debugging
 *
 * Isolation strategy
 * ------------------
 * Default (`scratch`): create a throwaway database, install the Supabase `auth`
 * shim, apply the real migrations, and run everything there — including the
 * two-connection concurrency race, which needs committed rows. The database is
 * dropped at the end. Your real data is never touched.
 *
 * Fallback (`transaction`): if the connecting role cannot create databases,
 * run in a single transaction against the target database and roll it back.
 * The concurrency race is skipped in this mode because it requires commits.
 *
 * Local (`local`): boot Postgres in-process with PGlite (no Docker, no server,
 * no credentials) and run everything against it. The concurrency race is
 * skipped: PGlite serialises queries across connections, so a real lock
 * contention race cannot be staged there. Use it for a fast, offline signal;
 * only a server run can prove the race.
 *
 * Requires DATABASE_URL (or TEST_DATABASE_URL) in the environment or .env.local,
 * except in `local` mode which supplies its own.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { ROOT, applyMigrations, loadEnvLocal } from "./lib/migrate.mjs";
import { ensureAuthShim } from "./lib/auth-shim.mjs";
const TESTS_DIR = join(ROOT, "tests", "sql");

const args = process.argv.slice(2);
const MODE = (args.find((a) => a.startsWith("--mode=")) ?? "--mode=scratch").split("=")[1];
const ONLY_FILE = args.find((a) => a.startsWith("--file="))?.split("=")[1] ?? null;
const KEEP = args.includes("--keep");
const LOCAL = MODE === "local";

loadEnvLocal();

let localPg = null;
let transform = null;

if (LOCAL) {
  const { startLocalPostgres, bridgeUnsupportedExtensions } = await import("./lib/local-pg.mjs");
  console.log("\nMode: local (PGlite — real Postgres 17+ in-process, no credentials)\n");
  localPg = await startLocalPostgres({ log: (m) => console.log(m) });
  transform = bridgeUnsupportedExtensions;
}

let baseUrl = LOCAL ? localPg.url : process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("\n  ✗ DATABASE_URL is not set (put it in .env.local)\n");
  process.exit(1);
}

const SSL = { rejectUnauthorized: false };
const report = { pass: 0, fail: 0, skip: 0, failures: [] };
function tally(row, file) {
  if (row.skipped) {
    report.skip += 1;
    return;
  }
  if (row.ok) {
    report.pass += 1;
    return;
  }
  report.fail += 1;
  report.failures.push({ file, label: row.label, detail: row.detail });
}

/** Connect to a specific database name derived from the base URL. */
function clientFor(dbName, overrides = {}) {
  const url = new URL(baseUrl);
  url.pathname = `/${dbName}`;
  // PGlite's socket server speaks plaintext on loopback and answers the
  // SSLRequest with "no"; asking for TLS there fails the handshake.
  return new pg.Client({ connectionString: url.toString(), ssl: LOCAL ? false : SSL, ...overrides });
}

/**
 * Postgres reports a character offset for a parse or plan error. Turn it into
 * the offending statement, so a CI log names the failing assertion instead of
 * just the file.
 */
function locateStatement(sql, position) {
  if (!Number.isFinite(position) || position < 1) return null;
  const at = position - 1;
  const start = sql.lastIndexOf(";", at) + 1;
  const end = sql.indexOf(";", at);
  return sql
    .slice(start, end === -1 ? sql.length : end + 1)
    .trim()
    .slice(0, 600);
}

async function runSqlFiles(client, files, log) {
  for (const file of files) {
    const sql = readFileSync(join(TESTS_DIR, file), "utf8");
    await client.query("select set_config('tc_test.file', $1, false)", [file]);

    // The results table is created by 00_helpers.sql, so it does not exist yet
    // on the first pass. to_regclass() avoids a parse-time error on the query.
    let lastId = 0;
    const { rows: exists } = await client.query("select to_regclass('tc_test.results') as t");
    if (exists[0].t) {
      const { rows } = await client.query("select coalesce(max(id), 0) as id from tc_test.results");
      lastId = rows[0].id;
    }

    // Each file is sent as one multi-statement query, which Postgres executes
    // as a single implicit transaction: a failure rolls the whole file back,
    // so a file that aborts records no assertions at all. That is deliberate —
    // a failed file leaves no half-applied fixtures behind — but it means a
    // file-level abort must be reported with its statement, not with counts.
    const collect = async () => {
      const { rows } = await client.query(
        "select label, ok, skipped, detail from tc_test.results where id > $1 order by id",
        [lastId],
      );
      for (const row of rows) tally(row, file);
      return rows;
    };

    let rows;
    try {
      await client.query(sql);
    } catch (error) {
      const statement = locateStatement(sql, error.position);
      const detail = [error.message, error.hint, error.where].filter(Boolean).join("\n      ");
      report.fail += 1;
      report.failures.push({ file, label: statement ?? "(file aborted)", detail });
      log(`  ✗ ${file} — aborted: ${error.message}`);
      if (statement) log(`      statement: ${statement.split("\n")[0].slice(0, 160)}`);
      try {
        rows = await collect();
        if (rows.length > 0) log(`      ${rows.length} assertion(s) recorded before the failure`);
      } catch {
        /* an aborted transaction leaves the session unusable until rollback */
        await client.query("rollback").catch(() => {});
      }
      return false;
    }

    rows = await collect();

    const failed = rows.filter((r) => !r.ok && !r.skipped).length;
    const skipped = rows.filter((r) => r.skipped).length;
    log(
      `  ${failed === 0 ? "✓" : "✗"} ${file} — ${rows.length - failed - skipped} passed` +
        `${failed ? `, ${failed} failed` : ""}${skipped ? `, ${skipped} skipped` : ""}`,
    );
  }
  return true;
}

/* -------------------------------------------------------------------------- */
/* Concurrency: two sessions racing for one reward                            */
/* -------------------------------------------------------------------------- */

async function concurrencyRace(dbName, log) {
  const a = clientFor(dbName);
  const b = clientFor(dbName);
  await a.connect();
  await b.connect();

  try {
    // Fixture, committed deliberately: the race needs two real transactions.
    const { rows: users } = await a.query(`
      insert into auth.users (email, raw_user_meta_data, email_confirmed_at)
      values ('race_a@test.invalid', '{"full_name":"Race A"}'::jsonb, now()),
             ('race_b@test.invalid', '{"full_name":"Race B"}'::jsonb, now())
      returning id
    `);
    const [authA, authB] = users.map((r) => r.id);
    const { rows: profiles } = await a.query(
      "select id from public.profiles where auth_user_id = any($1::uuid[]) order by email",
      [[authA, authB]],
    );
    const [userA, userB] = profiles.map((r) => r.id);

    const REWARD = 10;
    const { rows: campaign } = await a.query(
      `insert into public.video_campaigns (name, budget, spent, reward_per_view, status)
       values ('Race campaign', $1, 0, $1, 'ACTIVE') returning id`,
      [REWARD],
    );
    const { rows: video } = await a.query(
      `insert into public.videos (campaign_id, title, video_url, duration_seconds,
                                  required_watch_seconds, reward_amount, currency, daily_limit, status)
       values ($1, 'Race video', 'https://example.test/r.mp4', 30, 1, $2, 'KES', 10, 'ACTIVE')
       returning id`,
      [campaign[0].id, REWARD],
    );
    const videoId = video[0].id;

    const tokens = [];
    for (const user of [userA, userB]) {
      const { rows } = await a.query("select * from public.video_start($1, $2, null, null)", [user, videoId]);
      const token = rows[0].session_token;
      await a.query(
        `update public.video_watch_sessions
            set started_at = now() - interval '30 seconds',
                watched_seconds = required_watch_seconds,
                status = 'WATCHING'
          where session_token = $1`,
        [token],
      );
      tokens.push(token);
    }

    // Both transactions are open before either completes, so the campaign row
    // lock is genuinely contended.
    await a.query("begin");
    await b.query("begin");
    const [resA, resB] = await Promise.all([
      a.query("select * from public.video_complete_session($1, $2)", [userA, tokens[0]]),
      b.query("select * from public.video_complete_session($1, $2)", [userB, tokens[1]]),
    ]);
    await a.query("commit");
    await b.query("commit");

    const outcomes = [resA.rows[0], resB.rows[0]];
    const rewarded = outcomes.filter((o) => o.result_status === "REWARDED");
    const refused = outcomes.filter((o) => o.result_status === "REJECTED");

    const { rows: spent } = await a.query("select spent, budget from public.video_campaigns where id = $1", [
      campaign[0].id,
    ]);
    const { rows: rewards } = await a.query(
      "select count(*)::int as n from public.wallet_transactions where type = 'VIDEO_REWARD' and user_id = any($1::uuid[])",
      [[userA, userB]],
    );

    const checks = [
      ["exactly one of two concurrent completions is rewarded", rewarded.length === 1],
      ["the loser is refused rather than paid", refused.length === 1],
      [
        "the refusal cites the exhausted budget",
        refused.length === 1 && refused[0].reject_reason === "CAMPAIGN_BUDGET_EXHAUSTED",
      ],
      ["the campaign spends its budget exactly once", Number(spent[0].spent) === REWARD],
      ["spend never exceeds the budget", Number(spent[0].spent) <= Number(spent[0].budget)],
      ["only one reward row exists", rewards[0].n === 1],
    ];

    const file = "concurrent-campaign (two connections)";
    for (const [label, ok] of checks) {
      tally({ label, ok: Boolean(ok), skipped: false, detail: ok ? null : "see race output" }, file);
      if (!ok) log(`    · expected: ${label}`);
    }

    log(`  ${checks.every(([, ok]) => ok) ? "✓" : "✗"} ${file} — ${checks.filter(([, o]) => o).length}/${checks.length} passed`);
  } catch (error) {
    report.fail += 1;
    report.failures.push({
      file: "concurrent-campaign (two connections)",
      label: "(race aborted)",
      detail: error.message,
    });
    log(`  ✗ concurrent-campaign — aborted: ${error.message}`);
  } finally {
    await a.end().catch(() => {});
    await b.end().catch(() => {});
  }
}

/* -------------------------------------------------------------------------- */

async function main() {
  const files = readdirSync(TESTS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const ordered = ["00_helpers.sql", ...files.filter((f) => f !== "00_helpers.sql")];
  const selected = ONLY_FILE ? ordered.filter((f) => f === ONLY_FILE || f === "00_helpers.sql") : ordered;

  if (LOCAL) {
    const client = clientFor("postgres");
    await client.connect();
    try {
      await ensureAuthShim(client, (m) => console.log(m));
      const summary = await applyMigrations(client, { log: (m) => console.log(m), transform });
      console.log(`\nApplied ${summary.ran} migration(s), ${summary.skipped} already present\n`);

      await runSqlFiles(client, selected, (m) => console.log(m));
      console.log("  · concurrent-campaign — SKIPPED (PGlite serialises connections; needs a server)\n");
    } finally {
      await client.end().catch(() => {});
    }
  } else if (MODE === "transaction") {
    console.log("\nMode: transaction (rolled back; concurrency race skipped)\n");
    const client = clientFor(new URL(baseUrl).pathname.slice(1) || "postgres");
    await client.connect();
    try {
      await ensureAuthShim(client);
      await applyMigrations(client, { log: () => {} });
      await client.query("begin");
      await runSqlFiles(client, selected, (m) => console.log(m));
      await client.query("rollback");
      console.log("\n  · transaction rolled back — the database is unchanged");
    } finally {
      await client.end().catch(() => {});
    }
  } else {
    const scratch = `taskcash_moneytests_${Date.now().toString(36)}`;
    console.log(`\nMode: scratch — creating throwaway database ${scratch}\n`);

    const admin = clientFor("postgres");
    await admin.connect();
    try {
      await admin.query(`create database ${scratch}`);
    } catch (error) {
      await admin.end().catch(() => {});
      console.error(
        `\n  ✗ could not create a scratch database (${error.message}).\n` +
          "    Re-run with --mode=transaction to test in a rolled-back transaction instead.\n",
      );
      process.exit(1);
    }
    await admin.end();

    const client = clientFor(scratch);
    await client.connect();
    try {
      await ensureAuthShim(client, (m) => console.log(m));
      const summary = await applyMigrations(client, { log: (m) => console.log(m) });
      console.log(`\nApplied ${summary.ran} migration(s), ${summary.skipped} already present\n`);

      const ok = await runSqlFiles(client, selected, (m) => console.log(m));
      if (ok && !ONLY_FILE) await concurrencyRace(scratch, (m) => console.log(m));
    } finally {
      await client.end().catch(() => {});
      const cleanup = clientFor("postgres");
      await cleanup.connect();
      if (KEEP) {
        console.log(`\n  · kept ${scratch} for inspection (drop it when finished)\n`);
      } else {
        await cleanup.query(`drop database ${scratch} with (force)`);
      }
      await cleanup.end().catch(() => {});
    }
  }

  /* ---- report ---------------------------------------------------------- */
  console.log("\n" + "─".repeat(72));
  if (report.failures.length > 0) {
    console.log("\nFailures:\n");
    for (const f of report.failures) {
      console.log(`  ✗ [${f.file}] ${f.label}`);
      if (f.detail) console.log(`      ${f.detail}`);
    }
    console.log("");
  }
  console.log(
    `  ${report.fail === 0 ? "PASS" : "FAIL"} — ${report.pass} passed, ${report.fail} failed, ${report.skip} skipped`,
  );
  console.log("─".repeat(72) + "\n");

  if (localPg) await localPg.stop().catch(() => {});
  process.exit(report.fail === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(`\n  ✗ ${error.message}\n`);
  process.exit(1);
});
