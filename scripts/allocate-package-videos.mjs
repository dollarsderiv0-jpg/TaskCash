#!/usr/bin/env node
/**
 * Allocate the video catalogue across the packages, and pick the free welcome video.
 *
 *   npm run allocate:videos              # dry run — print the plan, change nothing
 *   npm run allocate:videos -- --apply   # write it
 *
 * WHY THIS IS NEEDED AT ALL
 * -------------------------
 * `video_complete_session` only enforces a package when the SESSION carries a
 * `package_id`, and `video_start` only sets one when the video is listed in
 * `package_videos`. With that table empty, every session had a NULL package_id,
 * the entire package gate (PACKAGE_REQUIRED, the per-package daily cap and the
 * lifetime cap) was skipped, and every one of the 305 videos paid KES 2 to any
 * ACTIVE account — no deposit required. The gating code was always correct; the
 * data never switched it on.
 *
 * TWO OUTPUTS
 * -----------
 *  1. ONE video stays out of `package_videos`. An unattached video is the only
 *     way to express "free", so exactly one is left unattached and its reward is
 *     set explicitly (default KES 40 — the welcome bonus).
 *  2. Every other ACTIVE video is attached to exactly one package. `package_videos`
 *     has a UNIQUE index on video_id, so a video belongs to ONE tier: tiers
 *     cannot share a catalogue, which is why the split has to be deliberate
 *     rather than "every package unlocks everything".
 *
 * THE SPLIT
 * ---------
 * Weighted by price, using the largest-remainder method so the counts always sum
 * exactly to the number of videos — a proportional split that rounded each tier
 * independently would silently drop or duplicate videos. Every tier also gets a
 * floor (`--min-per-tier`, default 2) so the cheapest tier is never left with a
 * single video: at KES 800 against a 207,800 price total, a pure proportional
 * split hands the entry tier one video, which is not a catalogue.
 *
 * The result is deterministic: videos are ordered by (created_at, id) and tiers
 * by (price, id), so re-running produces the same assignment.
 */

import { ROOT, loadEnvLocal } from "./lib/migrate.mjs";

loadEnvLocal();

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");

const url = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "").replace(/\/$/, "");
const key = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

if (!url || !key) {
  console.error("\n  ✗ NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY are required (put them in .env.local)\n");
  process.exit(2);
}

const H = { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" };

const flag = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const WELCOME_REWARD = Number(flag("welcome-reward", "40"));
const MIN_PER_TIER = Number(flag("min-per-tier", "2"));
const WELCOME_CAMPAIGN_BUDGET = Number(flag("welcome-budget", "400"));
const WELCOME_CAMPAIGN_NAME = "Welcome video (house campaign)";

async function get(path) {
  const res = await fetch(`${url}/rest/v1/${path}`, { headers: H });
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status} ${await res.text()}`);
  return res.json();
}

async function patch(path, body, prefer = "return=representation") {
  const res = await fetch(`${url}/rest/v1/${path}`, {
    method: "PATCH", headers: { ...H, Prefer: prefer }, body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`PATCH ${path} -> ${res.status} ${await res.text()}`);
  return res.status === 204 ? [] : res.json();
}

async function post(path, body) {
  const res = await fetch(`${url}/rest/v1/${path}`, {
    method: "POST", headers: { ...H, Prefer: "return=representation" }, body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${path} -> ${res.status} ${await res.text()}`);
  return res.json();
}

async function del(path) {
  const res = await fetch(`${url}/rest/v1/${path}`, { method: "DELETE", headers: H });
  if (!res.ok) throw new Error(`DELETE ${path} -> ${res.status} ${await res.text()}`);
}

/* -------------------------------------------------------------------------- */

const packages = await get("packages?select=id,name,price,status&status=eq.ACTIVE&order=price.asc,id.asc");
const videos = await get("videos?select=id,title,reward_amount,status,campaign_id&status=eq.ACTIVE&order=created_at.asc,id.asc");

if (packages.length === 0) { console.error("\n  ✗ no ACTIVE packages\n"); process.exit(2); }
if (videos.length <= packages.length) { console.error("\n  ✗ not enough ACTIVE videos to gate\n"); process.exit(2); }

const welcomeId = flag("welcome", videos[0].id);
const welcome = videos.find((v) => v.id === welcomeId);
if (!welcome) { console.error(`\n  ✗ welcome video ${welcomeId} is not an ACTIVE video\n`); process.exit(2); }

const toGate = videos.filter((v) => v.id !== welcome.id);

/* Largest-remainder split, weighted by price, with a per-tier floor. */
function split(count, tiers, minPerTier) {
  const reserved = Math.min(count, minPerTier * tiers.length);
  const free = count - reserved;
  const totalPrice = tiers.reduce((sum, t) => sum + Number(t.price), 0);

  const exact = tiers.map((t) => (free * Number(t.price)) / totalPrice);
  const counts = exact.map((x) => Math.floor(x));
  let remaining = free - counts.reduce((a, b) => a + b, 0);

  // Hand the remainder to the largest fractional parts, ties broken by price so
  // the result never depends on object iteration order.
  const order = tiers
    .map((t, i) => ({ i, frac: exact[i] - Math.floor(exact[i]), price: Number(t.price) }))
    .sort((a, b) => b.frac - a.frac || b.price - a.price);
  for (let n = 0; n < remaining; n += 1) counts[order[n].i] += 1;

  const floor = Math.min(minPerTier, Math.floor(count / tiers.length));
  return counts.map((c) => c + floor);
}

const counts = split(toGate.length, packages, MIN_PER_TIER);
const assignment = [];
let cursor = 0;
for (let i = 0; i < packages.length; i += 1) {
  for (let n = 0; n < counts[i]; n += 1) {
    assignment.push({ package_id: packages[i].id, video_id: toGate[cursor].id, sort_order: n + 1 });
    cursor += 1;
  }
}

/* -------------------------------------------------------------------------- */

console.log(`\n  TaskCash Pro — allocate the video catalogue\n`);
console.log(`  project        : ${url}`);
console.log(`  ACTIVE videos  : ${videos.length}   (1 free, ${toGate.length} gated)`);
console.log(`  ACTIVE tiers   : ${packages.length}\n`);

console.log(`  welcome video (left FREE, reward ${WELCOME_REWARD} KES):`);
console.log(`    ${welcome.title ?? welcome.id}`);
console.log(`    campaign: ${welcome.campaign_id ?? "(none)"}   current reward: ${welcome.reward_amount}\n`);

console.log("  tier            price    videos   reward/day cap   lifetime cap");
const tiersFull = await get(`packages?select=id,name,price,daily_earning_cap,lifetime_earning_cap&id=in.(${packages.map((p) => p.id).join(",")})`);
const capOf = new Map(tiersFull.map((t) => [t.id, t]));
for (let i = 0; i < packages.length; i += 1) {
  const p = packages[i];
  const cap = capOf.get(p.id) ?? {};
  console.log(
    `  ${String(p.name).slice(0, 14).padEnd(15)} ${String(p.price).padStart(6)}   ${String(counts[i]).padStart(6)}` +
    `   ${String(cap.daily_earning_cap ?? "-").padStart(14)}   ${String(cap.lifetime_earning_cap ?? "-").padStart(12)}`,
  );
}
console.log(`\n  total gated: ${assignment.length} of ${toGate.length}${assignment.length === toGate.length ? "" : "  ⚠ MISMATCH"}`);

if (!APPLY) {
  console.log("\n  · dry run — nothing was written. Re-run with --apply to write it.\n");
  process.exit(0);
}

/* -------------------------------------------------------------------------- */
/* apply                                                                      */
/* -------------------------------------------------------------------------- */

// 1. the welcome video: explicit reward, and a campaign that can actually fund it.
let campaigns = await get(`video_campaigns?select=id,name,budget,spent&name=eq.${encodeURIComponent(WELCOME_CAMPAIGN_NAME)}`);
if (campaigns.length === 0) {
  campaigns = await post("video_campaigns", {
    name: WELCOME_CAMPAIGN_NAME,
    description:
      `Funds the free welcome video (${WELCOME_REWARD} KES per new account). Created by ` +
      "scripts/allocate-package-videos.mjs. Raise `budget` to cover the number of signups you expect.",
    advertiser: "TaskCash Pro (self-funded house campaign)",
    budget: WELCOME_CAMPAIGN_BUDGET,
    reward_per_view: WELCOME_REWARD,
    status: "ACTIVE",
  });
}
const welcomeCampaign = campaigns[0];
await patch(`videos?id=eq.${welcome.id}`, { reward_amount: WELCOME_REWARD, campaign_id: welcomeCampaign.id });
console.log(`\n  ✓ welcome video set to ${WELCOME_REWARD} KES under campaign "${welcomeCampaign.name}"`);

const left = Number(welcomeCampaign.budget) - Number(welcomeCampaign.spent);
console.log(
  `    budget ${welcomeCampaign.budget} − spent ${welcomeCampaign.spent} = ${left} KES left` +
  ` → ${Math.floor(left / WELCOME_REWARD)} welcome rewards payable`,
);
if (Math.floor(left / WELCOME_REWARD) < 25) {
  console.log("    ⚠ raise `budget` before launch: this funds only a handful of signups.");
}

// 2. the allocation. This table is owned by this script, so it is replaced whole
//    rather than merged — a partial update would leave stale rows behind.
await del("package_videos?video_id=not.is.null");
for (let i = 0; i < assignment.length; i += 200) {
  await post("package_videos", assignment.slice(i, i + 200));
}
console.log(`  ✓ attached ${assignment.length} videos across ${packages.length} tiers`);

const check = await get("package_videos?select=package_id");
const gated = await get("videos?select=id&status=eq.ACTIVE");
const linked = new Set((await get("package_videos?select=video_id")).map((r) => r.video_id));
console.log(`\n  verify: ${check.length} rows, ${gated.filter((v) => !linked.has(v.id)).length} video(s) still free\n`);
