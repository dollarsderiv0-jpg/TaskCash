import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const MIGRATIONS_DIR = join(ROOT, "supabase", "migrations");

/**
 * Every table these migrations create. Anything else already in `public` means
 * this is not a dedicated TaskCash Pro database, and applying the migrations
 * would write into another application's schema.
 */
export const OWNED_TABLES = new Set([
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
  "rate_limits",
  "idempotency_keys",
  "payment_events",
  "reconciliation_alerts",
  "taskcash_migrations",
]);

/** Minimal .env.local loader. Real environment variables always win. */
export function loadEnvLocal() {
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

export function migrationFiles() {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort();
}

export function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export class MigrationError extends Error {}

/** Public tables that exist but are not ours. */
export async function foreignTables(client) {
  const { rows } = await client.query(
    `select c.relname as name
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r'`,
  );
  return rows
    .map((r) => r.name)
    .filter((name) => !OWNED_TABLES.has(name))
    .sort();
}

/**
 * Apply every migration in order.
 *
 * - refuses to run against a database holding tables this project does not own
 *   (unless allowExisting), so it cannot be pointed at another app's schema;
 * - each file is its own transaction, so a failure rolls that file back whole;
 * - applied files are recorded with a SHA-256 checksum and skipped on re-run;
 * - a file whose contents changed after being applied is refused.
 */
export async function applyMigrations(client, options = {}) {
  const {
    dryRun = false,
    allowExisting = false,
    log = () => {},
    // Local/hosted runs that are not Supabase need one or two statements
    // translated (see scripts/lib/local-pg.mjs). The transform is applied to
    // the SQL that is executed, never to the file on disk, and every file it
    // touches is named in the log so the deviation cannot pass unnoticed.
    transform = null,
  } = options;

  const foreign = await foreignTables(client);
  if (foreign.length > 0 && !allowExisting) {
    throw new MigrationError(
      `this database already contains ${foreign.length} table(s) that TaskCash Pro does not own:\n` +
        `    ${foreign.slice(0, 12).join(", ")}${foreign.length > 12 ? `, +${foreign.length - 12} more` : ""}\n\n` +
        "    Refusing to migrate: these migrations belong in a DEDICATED project, and this\n" +
        "    looks like another application's database. If you are certain, re-run with\n" +
        "    --allow-existing.",
    );
  }

  await client.query(`
    create table if not exists public.taskcash_migrations (
      version     text primary key,
      checksum    text not null,
      applied_at  timestamptz not null default now()
    )
  `);

  const { rows: applied } = await client.query(
    "select version, checksum from public.taskcash_migrations",
  );
  const appliedByVersion = new Map(applied.map((r) => [r.version, r.checksum]));

  const summary = { ran: 0, skipped: 0, files: migrationFiles() };

  for (const file of summary.files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    const shipped = sql;
    const execute = transform ? transform(sql, file) : sql;
    if (execute !== shipped) log(`  ! ${file} — translated for this environment (file on disk unchanged)`);
    const checksum = sha256(shipped);
    const previous = appliedByVersion.get(file);

    if (previous === checksum) {
      log(`  · ${file} — already applied, skipping`);
      summary.skipped += 1;
      continue;
    }

    if (previous && previous !== checksum) {
      throw new MigrationError(
        `${file} was already applied but its contents have changed.\n` +
          "    Refusing to re-run it: the database would no longer match this file.\n" +
          "    Add a new migration file instead of editing an applied one.",
      );
    }

    if (dryRun) {
      log(`  → ${file} — would apply (${sql.length} bytes)`);
      continue;
    }

    try {
      await client.query("begin");
      await client.query(execute);
      await client.query(
        "insert into public.taskcash_migrations (version, checksum) values ($1, $2)",
        [file, checksum],
      );
      await client.query("commit");
      log(`  → ${file} — applied`);
      summary.ran += 1;
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw new MigrationError(`${file} failed and was rolled back:\n    ${error.message}`);
    }
  }

  return summary;
}
