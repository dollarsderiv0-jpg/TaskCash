#!/usr/bin/env node
/**
 * Concatenate the migrations into one paste-ready file.
 *
 *   npm run db:bundle
 *
 * The output goes to `supabase/apply-all.sql` — deliberately OUTSIDE
 * `supabase/migrations/`, so the migration runner never sees it and cannot
 * apply the same schema twice.
 *
 * Why this exists: the primary path is `npm run db:migrate`, which needs
 * `DATABASE_URL` and therefore the database password. When only the dashboard
 * password is unavailable, the schema can still be applied by pasting this one
 * file into the Supabase SQL editor. Nothing here is a substitute for the
 * runner: the SQL editor gives no per-file transaction, no checksum record, and
 * no way to verify what landed. Prefer `db:migrate`, then confirm with
 * `db:verify`.
 *
 * `npm run db:reinit` imports `buildBundle()` to produce a combined
 * reset-then-apply file for a project that holds an incompatible earlier schema.
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS = join(ROOT, "supabase", "migrations");
const OUT = join(ROOT, "supabase", "apply-all.sql");

/** The full bundle as a string. Exported so `db:reinit` can reuse it verbatim. */
export function buildBundle() {
  const files = readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith(".sql"))
    .sort();

  if (files.length === 0) {
    throw new Error(`no .sql files in ${MIGRATIONS}`);
  }

  const header = [
    "-- ============================================================================",
    "-- TaskCash Pro — GENERATED FILE. DO NOT EDIT BY HAND.",
    "--",
    "-- Produced by `npm run db:bundle`. Edit the files in supabase/migrations/",
    "-- and regenerate.",
    "--",
    "-- Paste this whole file into the Supabase SQL editor and run it once.",
    "-- It is safe to run against an empty project only — the migrations use",
    "-- `create table if not exists` and friends, but a second run is not the",
    "-- supported path. Use the runner for anything repeatable:",
    "--",
    "--     npm run db:migrate      # order, transaction, checksum recorded",
    "--     npm run db:verify       # assert RLS, grants, constraints, seeds",
    "--",
    `-- Generated: ${new Date().toISOString()}`,
    `-- Sources: ${files.join(", ")}`,
    "-- ============================================================================",
    "",
  ].join("\n");

  const parts = [header];
  for (const file of files) {
    const body = readFileSync(join(MIGRATIONS, file), "utf8").trimEnd();
    parts.push(
      [
        "",
        "-- ----------------------------------------------------------------------------",
        `-- ${file}`,
        "-- ----------------------------------------------------------------------------",
        body,
        "",
      ].join("\n"),
    );
  }

  return { output: parts.join("\n"), files };
}

function main() {
  const { output, files } = buildBundle();
  writeFileSync(OUT, output);

  const statements = output
    .split("\n")
    .filter((line) => /^\s*(create|alter|drop|grant|revoke|insert|comment)\b/i.test(line)).length;

  console.log(`\n  Bundled ${files.length} migration(s) → supabase/apply-all.sql`);
  console.log(
    `  ${output.split("\n").length} lines, ${Math.round(output.length / 1024)} KB, ~${statements} top-level statements`,
  );
  console.log("\n  Supabase dashboard → SQL Editor → New query → paste the file → Run.");
  console.log("  Then re-run the app; it stops reporting PLATFORM_NOT_MIGRATED.\n");
}

// Run only when invoked as a script, so importing buildBundle() is silent.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(`\n  ✗ ${error.message}\n`);
    process.exit(1);
  }
}
