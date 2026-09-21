#!/usr/bin/env node
/**
 * Set the catalogue's reward per completed view, and report what it costs.
 *
 *   npm run reward:set -- --reward=10            # dry run — show the arithmetic
 *   npm run reward:set -- --reward=10 --apply    # write it
 *
 * WHY A SCRIPT AND NOT A MIGRATION
 * --------------------------------
 * `videos.reward_amount` is content configuration: the catalogue is created by
 * `videos:ingest` / `seed:demo-videos` (both take `--reward`), and the reward is
 * editable per video in /admin/videos. A migration would be a no-op on a fresh
 * environment — there are no video rows yet at that point — so it would document
 * nothing. The ingest flags are the real source of truth, which is why this
 * rewrites existing rows rather than being replayed on deploy.
 *
 * THE FREE VIDEO IS LEFT ALONE
 * ----------------------------
 * A video attached to no package is the free welcome video, and it pays its own
 * figure (40), not the catalogue's. It is identified by its absence from
 * `package_videos` rather than by id, so this keeps working if the welcome video
 * is ever swapped. `npm run allocate:videos -- --welcome=<id>` does the swapping.
 *
 * WHAT IT REPORTS
 * ---------------
 * Rising the reward does not create funding, so this prints two things that
 * decide whether the figure is affordable at all:
 *
 *   1. per CAMPAIGN — `budget / reward` is the hard number of rewards that
 *      campaign can ever pay, because `campaign_is_payable` refuses a payout that
 *      would take `spent` past `budget`. A campaign that cannot fund one reward
 *      per video in it has videos that can never pay.
 *   2. per TIER — what a buyer can actually reach over the package's term, against
 *      the lifetime cap the tier advertises. Videos have `daily_limit = 1`, so the
 *      ceiling is `videos x reward x duration_days`, which is usually far below the
 *      advertised cap. Warnings here are the operator's to resolve, not this
 *      script's: they are pricing decisions.
 */

import { loadEnvLocal } from "./lib/migrate.mjs";

loadEnvLocal();

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");

const flag = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const REWARD = Number(flag("reward", "0"));
if (!(REWARD > 0)) {
  console.error("\n  ✗ --reward is required and must be positive, e.g. --reward=10\n");
  process.exit(2);
}

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

/* -------------------------------------------------------------------------- */

const videos = await get("videos?select=id,title,reward_amount,campaign_id&status=eq.ACTIVE&order=created_at.asc,id.asc");
const links = await get("package_videos?select=video_id,package_id");
const campaigns = await get("video_campaigns?select=id,name,budget,spent,reward_per_view");
const packages = await get("packages?select=id,name,price,duration_days,daily_earning_cap,lifetime_earning_cap&status=eq.ACTIVE&order=price.asc");

const linked = new Map(links.map((r) => [r.video_id, r.package_id]));
const campaignById = new Map(campaigns.map((c) => [c.id, c]));

const free = videos.filter((v) => !linked.has(v.id));
const gated = videos.filter((v) => linked.has(v.id));

console.log(`\n  TaskCash Pro — set the catalogue reward\n`);
console.log(`  project   : ${url}`);
console.log(`  reward    : ${REWARD} per completed view`);
console.log(`  catalogue : ${videos.length} ACTIVE (${gated.length} gated, ${free.length} free)\n`);

for (const v of free) {
  console.log(`  free video left at its own figure: "${v.title}" — ${v.reward_amount}\n`);
}

const changing = gated.filter((v) => Number(v.reward_amount) !== REWARD);
console.log(`  ${changing.length} of ${gated.length} gated video(s) change (${gated.length - changing.length} already at ${REWARD})`);

/* 1 — can the campaigns fund it? ------------------------------------------- */

console.log("\n  campaign                        budget     spent      left   rewards   videos  funds all?");
let shortCampaigns = 0;
for (const c of campaigns) {
  const owned = gated.filter((v) => v.campaign_id === c.id).length;
  const left = Number(c.budget) - Number(c.spent);
  const affordable = Math.floor(left / REWARD);
  const fundsAll = affordable >= owned;
  if (!fundsAll) shortCampaigns += 1;
  console.log(
    `  ${String(c.name).slice(0, 30).padEnd(32)}${String(c.budget).padStart(7)}${String(c.spent).padStart(10)}` +
      `${String(left).padStart(10)}${String(affordable).padStart(10)}${String(owned).padStart(9)}   ${fundsAll ? "yes" : "NO"}`,
  );
}

const totalAffordable = campaigns.reduce((s, c) => s + Math.floor((Number(c.budget) - Number(c.spent)) / REWARD), 0);
console.log(
  `\n  whole platform: ${totalAffordable} more reward(s) can ever be paid at ${REWARD} KES` +
    ` — across ${gated.length} gated video(s) and every user.\n`,
);
if (shortCampaigns > 0) {
  console.log(`  ⚠ ${shortCampaigns} campaign(s) cannot fund one reward per video they own, so some`);
  console.log("    gated videos will report \"campaign budget exhausted\". Raise their budget.\n");
}

/* 2 — can the tiers reach what they advertise? ----------------------------- */

console.log("  tier            price   videos  max/day  max over term  advertised  reachable");
for (const p of packages) {
  const vs = gated.filter((v) => linked.get(v.id) === p.id);
  // Projected at the new reward, so a dry run answers the question it is asked.
  const perDay = vs.length * REWARD;
  const term = perDay * Number(p.duration_days);
  const advertised = Number(p.lifetime_earning_cap);
  const pct = advertised > 0 ? ((term / advertised) * 100).toFixed(0) : "n/a";
  console.log(
    `  ${String(p.name).slice(0, 13).padEnd(15)}${String(p.price).padStart(6)}${String(vs.length).padStart(9)}` +
      `${String(perDay).padStart(9)}${String(term).padStart(15)}${String(advertised).padStart(12)}${(pct + "%").padStart(11)}`,
  );
}
console.log(
  "\n  \"reachable\" is videos x reward x duration_days, because every video has daily_limit = 1.\n" +
    "  A figure below 100% means the tier cannot pay what it advertises; only the operator can\n" +
    "  fix that, by funding it, raising daily_limit, or lowering the advertised cap.\n",
);

if (!APPLY) {
  console.log("  · dry run — nothing was written. Re-run with --apply to write it.\n");
  process.exit(0);
}

/* -------------------------------------------------------------------------- */
/* apply                                                                      */
/* -------------------------------------------------------------------------- */

const ids = changing.map((v) => v.id);
for (let i = 0; i < ids.length; i += 200) {
  const chunk = ids.slice(i, i + 200);
  await patch(`videos?id=in.(${chunk.join(",")})`, { reward_amount: REWARD });
}
console.log(`  ✓ set ${ids.length} gated video(s) to ${REWARD} KES`);

/*
  The campaign's `reward_per_view` is informational — payability reads the VIDEO's
  reward — but left alone it shows a stale number in the admin UI.

  Only campaigns that actually fund CATALOGUE videos adopt the catalogue reward.
  The welcome video's campaign pays its own figure (the free video's 40) and must
  not be dragged down to the catalogue's number just because it differs.
*/
const catalogueCampaignIds = new Set(gated.map((v) => v.campaign_id).filter(Boolean));
const restale = campaigns.filter(
  (c) => catalogueCampaignIds.has(c.id) && Number(c.reward_per_view) !== REWARD,
);
for (const c of restale) {
  await patch(`video_campaigns?id=eq.${c.id}`, { reward_per_view: REWARD });
}
if (restale.length > 0) console.log(`  ✓ re-stated reward_per_view on ${restale.length} catalogue campaign(s)`);

const after = await get(`videos?select=reward_amount&status=eq.ACTIVE`);
const histogram = {};
for (const v of after) histogram[v.reward_amount] = (histogram[v.reward_amount] ?? 0) + 1;
console.log(`\n  verify: reward values now ${JSON.stringify(histogram)}\n`);
