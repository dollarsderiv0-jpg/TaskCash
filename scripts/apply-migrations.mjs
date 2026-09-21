#!/usr/bin/env node
/**
 * Apply supabase/migrations/*.sql in order, idempotently.
 *
 *   node scripts/apply-migrations.mjs [--dry-run] [--allow-existing]
 *
 * Requires DATABASE_URL (the Supabase "Session pooler" or direct connection
 * string) in the environment or in .env.local.
 *
 * The engine lives in scripts/lib/migrate.mjs and is shared with the money test
 * runner, so the safety rules below are enforced identically in both:
 *
 *   - it refuses to run against a database that already contains tables this
 *     project does not own, so it cannot be pointed at another application's
 *     schema by mistake (override deliberately with --allow-existing);
 *   - each file runs in its own transaction, so a failure rolls that file back
 *     completely and the database is never left half-migrated;
 *   - an applied migration is recorded with a SHA-256 checksum and skipped on
 *     re-run, so running this twice is a no-op;
 *   - a migration whose contents changed after being applied is refused.
 */

import pg from "pg";
import { applyMigrations, loadEnvLocal } from "./lib/migrate.mjs";

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const ALLOW_EXISTING = args.includes("--allow-existing");

function fail(message) {
  console.error(`\n  ✗ ${message}\n`);
  process.exit(1);
}

loadEnvLocal();

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  fail(
    "DATABASE_URL is not set.\n" +
      "    Add the connection string to .env.local (it is gitignored), e.g.\n" +
      "      DATABASE_URL=postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres\n" +
      "    Use the Session pooler or direct connection — not the transaction pooler.",
  );
}

const client = new pg.Client({
  connectionString: databaseUrl,
  // Supabase terminates TLS with a CA that is not always in the local trust
  // store. Traffic is still encrypted; this only skips chain verification.
  ssl: { rejectUnauthorized: false },
});

async function main() {
  await client.connect();

  const { rows: identity } = await client.query(
    "select current_database() as db, current_user as usr, version() as version",
  );
  console.log(`\nTarget: ${identity[0].db} (${client.host}:${client.port})`);
  console.log(identity[0].version.split(",")[0]);

  const summary = await applyMigrations(client, {
    dryRun: DRY_RUN,
    allowExisting: ALLOW_EXISTING,
    log: (line) => console.log(line),
  });

  console.log(
    DRY_RUN
      ? `\nDry run: ${summary.files.length} migration(s) inspected, nothing changed.\n`
      : `\nDone: ${summary.ran} applied, ${summary.skipped} already present.\n`,
  );
}

main()
  .then(() => client.end())
  .catch(async (error) => {
    await client.end().catch(() => {});
    fail(error.message);
  });
