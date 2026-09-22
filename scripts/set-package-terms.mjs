#!/usr/bin/env node
/**
 * Set each package's earning period and lifetime total.
 *
 *   npm run terms:set                              # report only — no changes
 *   npm run terms:set -- --terms="ACTIVE:800:14:952;DRAFT:2500:30:3400"          # dry run
 *   npm run terms:set -- --terms="..." --apply                                   # write it
 *
 * WHY A SCRIPT AND NOT A MIGRATION
 * --------------------------------
 * A tier's term and its cap are pricing decisions the operator makes against a
 * live catalogue, and they are editable in /admin/packages. A migration would
 * pin one set of numbers for every environment and freeze a moving decision —
 * the same reason `reward:set` rewrites rows rather than replaying a seed.
 *
 * KEYING: WHY THERE IS A STATUS PREFIX
 * ------------------------------------
 * The longer-term tiers deliberately reuse the short-term price points, so
 * `2500` alone is ambiguous — it is both "Package 2500" (14 days) and "Package
 * 2500 (30 days)" (DRAFT). Each entry therefore names the status it means:
 *
 *     STATUS:PRICE:DAYS:TOTAL
 *
 * An entry with no status applies only when the price is unique across every
 * non-archived package; otherwise the script stops rather than guessing which
 * tier was meant.
 *
 * WHAT IT REFUSES TO IGNORE
 * -------------------------
 * Raising a total does not create funding, and `campaign_is_payable` is the real
 * ceiling on every reward. So this reports, for each tier:
 *
 *   · `max/day`   — videos x reward. Every video has `daily_limit = 1`, so this
 *                   IS the ceiling on one day and a daily cap above it can never
 *                   be reached.
 *   · `reachable` — videos x reward x days: the most the tier can pay over its
 *                   whole term. A total above this is a number the tier cannot
 *                   deliver, however it is worded.
 *   · the remaining campaign pool for the whole platform, which is what actually
 *     stands behind all of it.
 *
 * Warnings are advice, not errors: they are pricing calls only the operator can
 * make. The script writes what it is told.
 *
 * THE DESCRIPTION IS PART OF THE TERMS
 * ------------------------------------
 * Migration 0014 wrote each package a `description` sentence that restates the
 * daily cap, the lifetime total and the term — "Up to KES 68 per day ... up to
 * KES 952 in total, for 14 days." The package card renders that sentence AND a
 * table of the same four figures, so the two are read together. Moving the
 * columns without moving the sentence therefore printed two offers on one card:
 * after this script last ran, Package 70000 advertised 83,300 over 14 days in
 * prose and 1,071,000 over 180 days in the table beneath it.
 *
 * So the sentence is treated as generated text, and kept in step whenever the
 * figures move. A description a person replaced with their own copy does not
 * match the generated pattern and is never overwritten — `--fix-descriptions`
 * repairs drift without a spec, and every run reports any card whose own text
 * disagrees with its columns.
 */

import { loadEnvLocal } from "./lib/migrate.mjs";

loadEnvLocal();

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const FIX_DESCRIPTIONS = args.includes("--fix-descriptions");

const flag = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const spec = flag("terms", "").trim();

const url = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "").replace(/\/$/, "");
const key = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
if (!url || !key) {
  console.error("\n  ✗ NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY are required (put them in .env.local)\n");
  process.exit(2);
}

const H = { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" };

async function get(path) {
  const res = await fetch(`${url}/rest/v1/${path}`, { headers: H });
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status} ${await res.text()}`);
  return res.json();
}

async function patch(path, body) {
  const res = await fetch(`${url}/rest/v1/${path}`, {
    method: "PATCH",
    headers: { ...H, Prefer: "return=representation" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`PATCH ${path} -> ${res.status} ${await res.text()}`);
  return res.status === 204 ? [] : res.json();
}

function parseTerms(raw) {
  return raw
    .split(";")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const parts = entry.split(":").map((p) => p.trim());
      if (parts.length === 3) {
        return { status: null, price: Number(parts[0]), days: Number(parts[1]), total: Number(parts[2]) };
      }
      if (parts.length === 4) {
        return {
          status: parts[0].toUpperCase(),
          price: Number(parts[1]),
          days: Number(parts[2]),
          total: Number(parts[3]),
        };
      }
      throw new Error(`cannot parse "${entry}" — expected STATUS:PRICE:DAYS:TOTAL or PRICE:DAYS:TOTAL`);
    });
}

/* -------------------------------------------------------------------------- */

/*
  The sentence migration 0014 generates, and nothing else. Hand-written copy is
  deliberately unmatched so it can never be clobbered by a pricing change.
*/
const GENERATED_DESCRIPTION =
  /^Up to KES ([\d,]+(?:\.\d+)?) per day from this package's videos, up to KES ([\d,]+(?:\.\d+)?) in total, for (\d+) days\.$/;

/* Postgres to_char(x, 'FM999,999,990'): grouped thousands, decimals kept as-is. */
function grouped(value) {
  const text = String(value);
  const [whole, fraction] = text.split(".");
  const sign = whole.startsWith("-") ? "-" : "";
  const digits = sign ? whole.slice(1) : whole;
  return sign + digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (fraction ? `.${fraction}` : "");
}

function describeTerms(daily, total, days) {
  return `Up to KES ${grouped(daily)} per day from this package's videos, up to KES ${grouped(total)} in total, for ${days} days.`;
}

function generatedDescription(text) {
  return typeof text === "string" && GENERATED_DESCRIPTION.test(text);
}

const packages = await get(
  "packages?select=id,name,price,status,description,duration_days,daily_earning_cap,lifetime_earning_cap&status=neq.ARCHIVED&order=price.asc,sort_order.asc",
);
const links = await get("package_videos?select=video_id,package_id");
const videos = await get("videos?select=id,reward_amount,status&status=eq.ACTIVE");
const campaigns = await get("video_campaigns?select=name,budget,spent");

const rewardOf = new Map(videos.map((v) => [v.id, Number(v.reward_amount)]));
const videosOf = new Map();
for (const link of links) {
  const reward = rewardOf.get(link.video_id);
  if (reward === undefined) continue;
  videosOf.set(link.package_id, [...(videosOf.get(link.package_id) ?? []), reward]);
}

const pool = campaigns.reduce((s, c) => s + (Number(c.budget) - Number(c.spent)), 0);

console.log(`\n  TaskCash Pro — set package terms\n`);
console.log(`  project          : ${url}`);
console.log(`  packages         : ${packages.length} (ARCHIVED excluded)`);
console.log(`  ACTIVE videos    : ${videos.length}, all at daily_limit = 1`);
console.log(`  campaign pool    : KES ${pool.toLocaleString()} left across every campaign`);
console.log(`  current total    : KES ${packages.reduce((s, p) => s + Number(p.lifetime_earning_cap), 0).toLocaleString()} of advertised lifetime caps\n`);

function row(p, days, total) {
  const rewards = videosOf.get(p.id) ?? [];
  const perDay = rewards.reduce((s, r) => s + r, 0);
  const reachable = perDay * days;
  const multiple = Number(p.price) > 0 ? total / Number(p.price) : 0;
  const reach = total > 0 ? (reachable / total) * 100 : 0;
  const status =
    Number(p.price) > 0 && total < Number(p.price)
      ? "pays below its price"
      : reach >= 100
        ? "reachable"
        : `only ${reach.toFixed(0)}% reachable`;

  console.log(
    `  ${String(p.name).slice(0, 26).padEnd(28)}${p.status.padEnd(7)}` +
      `${String(p.price).padStart(7)}${String(days).padStart(6)}d${String(rewards.length).padStart(8)}v` +
      `${String(perDay).padStart(8)}${String(reachable).padStart(10)}` +
      `${String(total).padStart(11)}${(multiple.toFixed(2) + "x").padStart(8)}   ${status}`,
  );

  return { perDay, reachable, total };
}

const header =
  `\n  ${"tier".padEnd(28)}${"status".padEnd(7)}${"price".padStart(7)}${"term".padStart(7)}${"videos".padStart(9)}` +
  `${"max/day".padStart(8)}${"reachable".padStart(10)}${"in total".padStart(11)}${"x price".padStart(8)}\n`;

console.log(header);

for (const p of packages) {
  row(p, Number(p.duration_days), Number(p.lifetime_earning_cap));
}

/*
  A card contradicts itself when its own sentence and its columns disagree. The
  buyer reads both, so this is reported on every run — including a report-only
  one, where it is the only way to see it without opening the site.
*/
const drifted = packages.filter((p) => {
  if (!generatedDescription(p.description)) return false;
  return p.description !== describeTerms(
    Number(p.daily_earning_cap),
    Number(p.lifetime_earning_cap),
    Number(p.duration_days),
  );
});

if (drifted.length > 0) {
  console.log(
    `\n  ⚠ ${drifted.length} card(s) print their own numbers, and they disagree with the columns:\n`,
  );
  for (const p of drifted) {
    const match = GENERATED_DESCRIPTION.exec(p.description);
    console.log(`      ${String(p.name).padEnd(26)} text ${match[2].padStart(11)}, ${match[3].padStart(3)} days`);
    console.log(
      `      ${"".padEnd(26)} fact ${grouped(Number(p.lifetime_earning_cap)).padStart(11)}, ${String(p.duration_days).padStart(3)} days`,
    );
  }
  console.log(`\n      repair with --fix-descriptions (only generated text is rewritten)\n`);
}

if (FIX_DESCRIPTIONS) {
  if (drifted.length === 0) {
    console.log("\n  · every generated description already matches its figures — nothing to repair\n");
  } else if (!APPLY) {
    console.log(`  · dry run — nothing was written. Re-run with --fix-descriptions --apply\n`);
  } else {
    for (const p of drifted) {
      await patch(`packages?id=eq.${p.id}`, {
        description: describeTerms(
          Number(p.daily_earning_cap),
          Number(p.lifetime_earning_cap),
          Number(p.duration_days),
        ),
      });
      console.log(`  ✓ repaired ${p.name}`);
    }
  }
  if (!spec) process.exit(0);
}

if (!spec) {
  console.log(
    "\n  · report only — pass --terms to change anything.\n" +
      "    e.g. --terms=\"ACTIVE:800:14:952;ACTIVE:2500:20:3000;DRAFT:2500:30:3400\"\n" +
      "    or --fix-descriptions to repair a card whose text contradicts its figures.\n\n" +
      "    \"reachable\" is videos x reward x days. A row below 100% cannot pay what it\n" +
      "    advertises, however the total is worded. Fix it by funding the campaign,\n" +
      "    raising daily_limit, allocating more videos, or lowering the total.\n",
  );
  process.exit(0);
}

/* -------------------------------------------------------------------------- */
/* resolve the spec against the catalogue                                     */
/* -------------------------------------------------------------------------- */

let wanted;
try {
  wanted = parseTerms(spec);
} catch (error) {
  console.error(`\n  ✗ ${error.message}\n`);
  process.exit(2);
}

const plan = [];
const errors = [];

for (const entry of wanted) {
  if (!(entry.days > 0)) errors.push(`days must be positive (got ${entry.days})`);
  if (!(entry.total > 0)) errors.push(`total must be positive (got ${entry.total})`);

  const candidates = packages.filter(
    (p) =>
      Number(p.price) === entry.price && (entry.status === null || p.status === entry.status),
  );

  if (candidates.length === 0) {
    errors.push(`no ${entry.status ?? ""} package priced ${entry.price}`.replace("  ", " "));
    continue;
  }
  if (candidates.length > 1 && entry.status === null) {
    errors.push(
      `price ${entry.price} matches ${candidates.length} packages (${candidates
        .map((p) => p.status)
        .join(", ")}) — add the status prefix`,
    );
    continue;
  }

  for (const p of candidates) {
    /*
      Rounded UP to the cent. Rounded down, `daily x days` would land just under
      the total and the last few shillings of the advertised figure would be
      unreachable — a cap the buyer can never finish, which reads as a bug.
    */
    const daily = Math.ceil((entry.total / entry.days) * 100) / 100;
    plan.push({ package: p, days: entry.days, total: entry.total, daily });
  }
}

const seen = new Set();
for (const item of plan) {
  if (seen.has(item.package.id)) errors.push(`${item.package.name} listed twice`);
  seen.add(item.package.id);
}

if (errors.length > 0) {
  console.error("\n  ✗ the spec does not resolve:\n");
  for (const e of errors) console.error(`      ${e}`);
  console.error("");
  process.exit(2);
}

const untouched = packages.filter((p) => !seen.has(p.id));

console.log(`\n  ${plan.length} tier(s) in the spec${untouched.length > 0 ? `, ${untouched.length} left as they are` : ""}\n`);
console.log(header);

let newTotal = 0;
const shortfalls = [];

for (const item of plan) {
  const { reachable } = row(item.package, item.days, item.total);
  newTotal += item.total;
  if (reachable < item.total) {
    shortfalls.push({ name: item.package.name, reachable, total: item.total });
  }
}

for (const p of untouched) {
  newTotal += Number(p.lifetime_earning_cap);
}

console.log(
  `\n  advertised totals after this change: KES ${newTotal.toLocaleString()} across every tier` +
    `,\n  against KES ${pool.toLocaleString()} actually remaining in the campaigns behind them` +
    ` (${(newTotal / Math.max(pool, 1)).toFixed(1)}x the money that exists).\n`,
);

if (shortfalls.length > 0) {
  console.log(`  ⚠ ${shortfalls.length} tier(s) cannot pay the total they would advertise:\n`);
  for (const s of shortfalls) {
    console.log(
      `      ${s.name.padEnd(30)} can pay ${s.reachable.toLocaleString().padStart(9)} of ${s.total.toLocaleString().padStart(9)}`,
    );
  }
  console.log("");
}

const below = plan.filter((i) => i.total < Number(i.package.price));
if (below.length > 0) {
  console.log(`  ⚠ ${below.length} tier(s) would advertise a total BELOW their own price:\n`);
  for (const i of below) {
    console.log(`      ${i.package.name.padEnd(30)} pays ${i.total} on a ${i.package.price} package`);
  }
  console.log("");
}

if (!APPLY) {
  console.log("  · dry run — nothing was written. Re-run the same command with --apply to write it.\n");
  process.exit(0);
}

/* -------------------------------------------------------------------------- */
/* apply                                                                      */
/* -------------------------------------------------------------------------- */

let written = 0;
let described = 0;
for (const item of plan) {
  const unchanged =
    Number(item.package.duration_days) === item.days &&
    Number(item.package.daily_earning_cap) === item.daily &&
    Number(item.package.lifetime_earning_cap) === item.total;

  /*
    The description travels with the figures, so a re-priced tier never keeps a
    sentence describing what it used to pay — including when only the sentence is
    stale. Skipping on `unchanged` alone is what let the drift happen before.
  */
  const patchBody = {
    duration_days: item.days,
    daily_earning_cap: item.daily,
    lifetime_earning_cap: item.total,
  };

  if (generatedDescription(item.package.description)) {
    const wanted = describeTerms(item.daily, item.total, item.days);
    if (item.package.description !== wanted) {
      patchBody.description = wanted;
      described += 1;
    }
  }

  if (unchanged && patchBody.description === undefined) continue;

  await patch(`packages?id=eq.${item.package.id}`, patchBody);
  if (!unchanged) written += 1;
}

console.log(
  `  ✓ set terms on ${written} tier(s) (${plan.length - written} already matched)` +
    (described > 0 ? `, rewrote ${described} generated description(s) to match` : ""),
);

/*
  Existing purchases are untouched on purpose. `user_packages` snapshots the cap
  and the expiry at the moment of sale, and `package_daily_usage` reads the
  snapshot — so a tier re-priced today cannot move what someone already bought,
  and moving a term here never retroactively shortens a live package.
*/
const held = await get("user_packages?select=id");
console.log(`  · ${held.length} existing purchase(s) keep the terms they were sold; snapshots are not rewritten\n`);
