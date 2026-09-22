#!/usr/bin/env node
/**
 * Give each tier a slice of the SHARED catalogue, at that tier's own rate.
 *
 *   npm run catalogue:set                                        # report only
 *   npm run catalogue:set -- --tiers="800:6:10;2500:6:30"        # dry run
 *   npm run catalogue:set -- --tiers="800:6:10;2500:6:30" --apply
 *
 * WHY A PREFIX, AND WHY SHARED
 * ----------------------------
 * Since 0020 a video may belong to several packages and pays a different figure
 * in each (`package_videos.reward_amount`). So the tiers no longer divide a
 * catalogue between them — they each take a PREFIX of one ordered catalogue:
 *
 *     800   → videos 1-6   at 10
 *     2500  → videos 1-6   at 30
 *     5000  → videos 1-9   at 45
 *
 * Tier 3 therefore contains everything tier 1 has, plus more, at a higher rate.
 * "The same six videos pay 10 under the entry tier and 30 under the next" is
 * exactly this, and adding a tier never takes content away from another one.
 *
 * A prefix of a fixed order is deliberate: it is stable, so re-running changes
 * nothing that was not asked for, and the set a buyer sees is not reshuffled
 * under them. The order is oldest-first by `created_at`, so publishing a new
 * video extends the tail rather than displacing the head.
 *
 * WHAT IT REFUSES TO IGNORE
 * -------------------------
 * `videos.daily_limit` is 1, so a tier's ceiling is `count x rate` per day, and
 * `count x rate x days` over its term. A rate above the tier's daily cap means
 * the cap is hit mid-way and the last videos watched that day are refused. Both
 * are reported per tier before anything is written.
 *
 * Entries are `STATUS:PRICE:COUNT:RATE`, or `PRICE:COUNT:RATE` when the price is
 * unambiguous. The status prefix is required where it is not: the DRAFT ladder
 * reuses the ACTIVE price points, so `2500` alone matches two packages and the
 * script stops rather than guessing which tier was meant.
 */

import { loadEnvLocal } from "./lib/migrate.mjs";

loadEnvLocal();

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const PRUNE = args.includes("--prune");

const flag = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const spec = flag("tiers", "").trim();

const url = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "").replace(/\/$/, "");
const key = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
if (!url || !key) {
  console.error("\n  ✗ NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY are required (.env.local)\n");
  process.exit(2);
}

const H = { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" };

async function get(path) {
  const res = await fetch(`${url}/rest/v1/${path}`, { headers: H });
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status} ${await res.text()}`);
  return res.json();
}

async function send(method, path, body) {
  const res = await fetch(`${url}/rest/v1/${path}`, {
    method,
    headers: { ...H, Prefer: "return=representation" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${await res.text()}`);
  return res.status === 204 ? [] : res.json();
}

/* -------------------------------------------------------------------------- */

const packages = await get(
  "packages?select=id,name,price,status,duration_days,daily_earning_cap&status=neq.ARCHIVED&order=price.asc,sort_order.asc",
);
const videos = await get(
  "videos?select=id,title,reward_amount&status=eq.ACTIVE&order=created_at.asc,id.asc",
);
const links = await get("package_videos?select=package_id,video_id");

const alreadyGated = new Set(links.map((r) => r.video_id));

/*
  The free welcome video is the one in NO package: that absence is how "no gate"
  is expressed, and attaching it to a tier would silently put a price on it.
*/
const free = videos.filter((v) => !alreadyGated.has(v.id));
const catalogue = videos.filter((v) => alreadyGated.has(v.id));

console.log(`\n  TaskCash Pro — set each tier's slice of the shared catalogue\n`);
console.log(`  project        : ${url}`);
console.log(`  ACTIVE videos  : ${videos.length} (${catalogue.length} in the catalogue, ${free.length} free)`);
if (free.length > 0) {
  console.log(`  free video     : "${free[0].title}" — left out of every tier, deliberately`);
}
console.log(`  tiers          : ${packages.length} non-archived\n`);

if (!spec) {
  console.log("  · report only — pass --tiers to change anything.\n");
  console.log("    e.g. --tiers=\"800:6:10;2500:6:30;5000:9:45\"\n");
  console.log("    Entries are PRICE:COUNT:RATE — the first COUNT catalogue videos, at RATE each.\n");
  process.exit(0);
}

const wanted = spec
  .split(";")
  .map((s) => s.trim())
  .filter(Boolean)
  .map((entry) => {
    const parts = entry.split(":").map((p) => p.trim());
    if (parts.length === 3) {
      return { status: null, price: Number(parts[0]), count: Number(parts[1]), rate: Number(parts[2]) };
    }
    if (parts.length === 4) {
      return {
        status: parts[0].toUpperCase(),
        price: Number(parts[1]),
        count: Number(parts[2]),
        rate: Number(parts[3]),
      };
    }
    throw new Error(`cannot parse "${entry}" — expected STATUS:PRICE:COUNT:RATE or PRICE:COUNT:RATE`);
  });

const errors = [];
const plan = [];

for (const entry of wanted) {
  if (!(entry.price > 0)) errors.push(`price must be positive (got ${entry.price})`);
  if (!(entry.count > 0)) errors.push(`count must be positive (got ${entry.count})`);
  if (!(entry.rate > 0)) errors.push(`rate must be positive (got ${entry.rate})`);
  if (entry.count > catalogue.length) {
    errors.push(`${entry.count} videos requested but the catalogue holds ${catalogue.length}`);
    continue;
  }

  const matches = packages.filter(
    (p) => Number(p.price) === entry.price && (entry.status === null || p.status === entry.status),
  );
  if (matches.length === 0) {
    errors.push(`no ${entry.status ?? "non-archived"} package priced ${entry.price}`.replace("  ", " "));
    continue;
  }
  if (matches.length > 1 && entry.status === null) {
    errors.push(
      `price ${entry.price} matches ${matches.length} packages (${matches
        .map((p) => p.status)
        .join(", ")}) — the DRAFT ladder reuses the ACTIVE prices; add the status prefix`,
    );
    continue;
  }

  const tier = matches[0];
  const prefix = catalogue.slice(0, entry.count).map((v) => v.id);

  /*
    What the tier will ACTUALLY hold, not just the prefix.

    Without --prune the apply is additive, so a tier keeps everything it already
    gated and gains the prefix — which can be far more videos than the prefix
    alone. Reporting only the prefix would understate the per-day figure and hide
    a rate that overshoots the tier's own cap.
  */
  const existingIds = links.filter((r) => r.package_id === tier.id).map((r) => r.video_id);
  const finalIds = PRUNE ? prefix : Array.from(new Set([...existingIds, ...prefix]));

  plan.push({ tier, ids: prefix, finalCount: finalIds.length, ...entry });
}

if (errors.length > 0) {
  console.error("\n  ✗ the spec does not resolve:\n");
  for (const e of errors) console.error(`      ${e}`);
  console.error("");
  process.exit(2);
}

console.log(
  `  ${"tier".padEnd(30)}${"price".padStart(7)}${"videos".padStart(8)}${"rate".padStart(7)}` +
    `${"per day".padStart(9)}${"cap".padStart(8)}${"over term".padStart(11)}`,
);

for (const item of plan) {
  const perDay = item.finalCount * item.rate;
  const cap = Number(item.tier.daily_earning_cap);
  const overTerm = perDay * Number(item.tier.duration_days);
  const flagText = cap > 0 && perDay > cap ? "  ⚠ over cap" : "";
  console.log(
    `  ${String(item.tier.name).slice(0, 28).padEnd(30)}${String(item.tier.price).padStart(7)}` +
      `${String(item.finalCount).padStart(8)}${String(item.rate).padStart(7)}` +
      `${String(perDay).padStart(9)}${String(cap).padStart(8)}${String(overTerm).padStart(11)}${flagText}`,
  );
}

const over = plan.filter(
  (i) => Number(i.tier.daily_earning_cap) > 0 && i.finalCount * i.rate > Number(i.tier.daily_earning_cap),
);
if (over.length > 0) {
  console.log(
    `\n  ⚠ ${over.length} tier(s) pay more per day than their own cap allows. The cap refuses the` +
      `\n    reward whole, so the last videos watched on those tiers are simply not paid.` +
      `\n    Lower the rate, or lower the count, or raise the tier's cap with terms:set.`,
  );
}

/*
  Nothing may become FREE by accident.

  A video is free exactly when it is in no package, so a tier re-pointed away
  from a video it used to hold either orphans that video (a hole in the gate) or
  leaves it attached (harmless). This computes which videos would end up ungated
  and refuses to proceed without --prune and --allow-free.
*/
const postGated = new Set(links.map((r) => r.video_id));
for (const item of plan) {
  for (const id of item.ids) postGated.add(id);
  if (PRUNE) {
    for (const row of links.filter((r) => r.package_id === item.tier.id)) {
      if (!item.ids.includes(row.video_id)) postGated.delete(row.video_id);
    }
  }
}

const orphaned = catalogue.filter((v) => !postGated.has(v.id));

if (orphaned.length > 0) {
  console.log(`
  ⚠ ${orphaned.length} catalogue video(s) would end up in NO package — i.e. free to watch
    and earn from by any ACTIVE account:
`);
  for (const v of orphaned.slice(0, 8)) console.log(`      ${v.title}`);
  if (orphaned.length > 8) console.log(`      …and ${orphaned.length - 8} more`);
  console.log(
    `
    Running with --prune makes those removals. Add the videos to another tier first,
    or pass --allow-free if a gap in the gate is really what is wanted.\n`,
  );

  if (!PRUNE || !args.includes("--allow-free")) {
    console.error("  ✗ refused — nothing was written.\n");
    process.exit(2);
  }
}

if (!APPLY) {
  console.log("\n  · dry run — nothing was written. Re-run the same command with --apply.\n");
  process.exit(0);
}

/* -------------------------------------------------------------------------- */
/* apply                                                                      */
/* -------------------------------------------------------------------------- */

for (const item of plan) {
  const existing = links.filter((r) => r.package_id === item.tier.id);
  const keep = new Set(item.ids);

  /*
    Rows for videos outside the new prefix are removed ONLY with --prune.

    Removing one is not a tidy-up: a video in no package is the definition of
    FREE, so dropping a row without attaching that video somewhere else silently
    turns a paid view into an unpaid one. Defaulting to additive means the worst
    case is a tier that gates more than it was asked to, which is visible and
    harmless, rather than a hole in the gate.
  */
  const drop = PRUNE ? existing.filter((r) => !keep.has(r.video_id)).map((r) => r.video_id) : [];
  for (const videoId of drop) {
    await send("DELETE", `package_videos?package_id=eq.${item.tier.id}&video_id=eq.${videoId}`);
  }

  const held = new Set(existing.map((r) => r.video_id));
  const add = item.ids.filter((id) => !held.has(id));

  for (let i = 0; i < add.length; i += 200) {
    const chunk = add.slice(i, i + 200);
    await send(
      "POST",
      "package_videos",
      chunk.map((videoId, n) => ({
        package_id: item.tier.id,
        video_id: videoId,
        reward_amount: item.rate,
        sort_order: i + n + 1,
      })),
    );
  }

  /*
    The rate is set on every row, including ones that were already attached — a
    tier whose rate is being changed must not leave half its catalogue on the old
    figure.
  */
  await send("PATCH", `package_videos?package_id=eq.${item.tier.id}`, { reward_amount: item.rate });

  console.log(
    `  ✓ ${item.tier.name}: ${item.ids.length} video(s) at ${item.rate} (removed ${drop.length}, added ${add.length})`,
  );
}

console.log(
  "\n  · existing purchases are untouched: caps and terms live on `user_packages` and are not rewritten.\n" +
    "  · a refund of a package whose video set changed is a support matter, not a data fix.\n",
);
