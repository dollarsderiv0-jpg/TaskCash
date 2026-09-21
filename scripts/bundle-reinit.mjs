#!/usr/bin/env node
/**
 * One paste that reinitialises a project holding an INCOMPATIBLE earlier schema.
 *
 *   npm run db:reinit
 *
 * Produces `supabase/reinit.sql`:
 *
 *   part 1 — supabase/reset-incompatible-schema.sql (guarded drop; refuses if
 *            the project holds accounts or user rows)
 *   part 2 — the full migration bundle, byte-identical to `apply-all.sql`
 *
 * Why one file instead of two paste steps: the SQL editor runs a pasted script
 * in a single transaction, so combining them means a reset that cannot be left
 * half-finished. If the guard refuses, nothing is dropped and nothing is
 * applied — you are exactly where you started, with the reason printed.
 *
 * `create table if not exists` cannot repair the earlier generation of this
 * schema: the table names match, so the statements are silently skipped and the
 * old columns survive, after which every later migration fails on a column that
 * was never added. Dropping is the only honest fix, which is why the guard is
 * the first thing in the file.
 *
 * Read `supabase/reset-incompatible-schema.sql` before running this. It is a
 * destructive script for an empty project, not a migration.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildBundle } from "./bundle-migrations.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RESET = join(ROOT, "supabase", "reset-incompatible-schema.sql");
const OUT = join(ROOT, "supabase", "reinit.sql");

const reset = readFileSync(RESET, "utf8").trimEnd();
const { output: bundle, files } = buildBundle();

const header = [
  "-- ============================================================================",
  "-- TaskCash Pro — GENERATED FILE. DO NOT EDIT BY HAND.",
  "--",
  "-- Produced by `npm run db:reinit`.",
  "--",
  "-- STEP 1  drops an INCOMPATIBLE earlier TaskCash Pro schema — but REFUSES",
  "--         to run at all if the project holds accounts or user rows.",
  "-- STEP 2  applies the full current schema on top.",
  "--",
  "-- One paste, one transaction: if the guard refuses, nothing is dropped and",
  "-- nothing is applied. Read supabase/reset-incompatible-schema.sql first.",
  "--",
  "-- Use this ONLY on a project whose schema cannot be repaired in place.",
  "-- For an empty project, or a re-run, use `npm run db:migrate` or",
  "-- `supabase/apply-all.sql` instead.",
  "--",
  `-- Generated: ${new Date().toISOString()}`,
  `-- Sources: reset-incompatible-schema.sql, ${files.join(", ")}`,
  "-- ============================================================================",
  "",
].join("\n");

const output = [header, reset, "", bundle].join("\n");
writeFileSync(OUT, output);

const lines = output.split("\n").length;
console.log(`\n  Built supabase/reinit.sql — reset + ${files.length} migration(s)`);
console.log(`  ${lines} lines, ${Math.round(output.length / 1024)} KB`);
console.log("\n  Supabase dashboard → SQL Editor → New query → paste the file → Run.");
console.log("  Then:  npm run verify:remote\n");
