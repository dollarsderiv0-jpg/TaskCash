#!/usr/bin/env node
/**
 * Bring a configured backend from "credentials present" to "verified", in the
 * only order that is safe.
 *
 *   npm run backend:setup
 *
 * Steps, each of which must pass before the next runs:
 *
 *   1. preflight     — is every required variable present and well-formed?
 *   2. db:migrate    — apply supabase/migrations in order (refuses to touch a
 *                      database holding tables TaskCash Pro does not own)
 *   3. db:verify     — assert RLS, constraints and ledger immutability against
 *                      the live database
 *   4. test:money    — run the 182-assertion invariant suite on the real server,
 *                      including the two-connection concurrency race
 *
 * It changes nothing until step 2, and step 2 changes nothing outside
 * `public` in the database you pointed it at. Nothing here is a payment test:
 * moving real money still requires SasaPay credentials and a human approving a
 * withdrawal.
 *
 * This script only orchestrates — it deliberately re-implements no check, so
 * `npm run preflight` alone always tells the same truth as this run.
 */

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const STEPS = [
  { name: "preflight", script: "scripts/preflight.mjs", args: [], why: "configuration" },
  { name: "db:migrate", script: "scripts/apply-migrations.mjs", args: [], why: "schema" },
  { name: "db:verify", script: "scripts/verify-backend.mjs", args: [], why: "security and constraints" },
  { name: "test:money", script: "scripts/run-money-tests.mjs", args: [], why: "money invariants" },
];

const results = [];

console.log("\n  TaskCash Pro — backend setup\n");

for (const step of STEPS) {
  console.log(`\n${"─".repeat(72)}\n  ${step.name} — ${step.why}\n${"─".repeat(72)}\n`);

  const run = spawnSync(process.execPath, [join(ROOT, step.script), ...step.args], {
    cwd: ROOT,
    stdio: "inherit",
    env: process.env,
  });

  const ok = run.status === 0;
  results.push({ name: step.name, ok });

  if (!ok) {
    console.log(`\n  ✗ ${step.name} failed — stopping here.\n`);
    break;
  }
}

console.log("\n" + "─".repeat(72));
console.log("\n  Summary\n");
for (const r of results) {
  console.log(`    ${r.ok ? "✓" : "✗"} ${r.name}`);
}
for (const step of STEPS) {
  if (!results.some((r) => r.name === step.name)) console.log(`    · ${step.name} — not reached`);
}
console.log("");

const failed = results.some((r) => !r.ok);
if (!failed && results.length === STEPS.length) {
  console.log("  Backend schema, security and money invariants all verified.");
  console.log("  Not covered here, and still required before real money moves:");
  console.log("    · Supabase security and performance advisors");
  console.log("    · SasaPay credentials, and a live deposit/withdrawal round trip");
  console.log("    · promoting the first administrator (registration never does)\n");
} else {
  console.log("  Setup is incomplete. Fix the failing step above and re-run.\n");
}

process.exit(failed ? 1 : 0);
