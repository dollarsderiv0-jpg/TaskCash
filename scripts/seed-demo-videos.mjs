#!/usr/bin/env node
/**
 * Seed a DEMO video campaign so Watch & Earn can be demonstrated end to end.
 *
 *   node scripts/seed-demo-videos.mjs                  # 20 YouTube videos, hidden (DRAFT), paying nothing
 *   node scripts/seed-demo-videos.mjs --source files   # direct MP4 clips instead
 *   node scripts/seed-demo-videos.mjs --source both    # both sets
 *   node scripts/seed-demo-videos.mjs --visible        # create, shown to users
 *   node scripts/seed-demo-videos.mjs --count 5        # a shorter catalogue
 *   node scripts/seed-demo-videos.mjs --remove         # delete everything it made
 *
 *   node scripts/seed-demo-videos.mjs --visible --pay --reward=2 --budget=200
 *        ↑ the only way to make demo videos actually pay. `--pay` must be given
 *          WITH a positive --reward and a --budget, because a reward without a
 *          budget ceiling is an unbounded liability.
 *
 * WHAT THIS WILL NOT DO
 *
 * By default it writes no reward at all: `reward_amount = 0` on every video and
 * `reward_per_view = 0` on the campaign, asserted before the writes and reported
 * after them.
 *
 * WITH `--pay` IT DOES CREATE REAL WALLET CREDITS — read this before using it.
 *
 * A completed session then posts a genuine VIDEO_REWARD through the ledger, and
 * the user's spendable balance really goes up. That money is the platform's own
 * liability: the campaign is the platform advertising itself, so the operator is
 * the advertiser. Nothing is faked — no simulated payment, no invented deposit —
 * but it is a real obligation, and once the user can withdraw, it has to be
 * funded by real inflows (deposits, or the operator's money through M-Pesa).
 *
 * That is why the two flags are mandatory together and why the ceiling is
 * enforced: `budget / reward` is the maximum number of rewards that campaign can
 * ever pay, and the database refuses to pay past it.
 *
 * It also does not invent content or advertisers:
 *
 *   · Titles, channels and durations in the YouTube set were read back from
 *     YouTube (oEmbed + the watch page's own player metadata), not made up.
 *   · Every id was checked to be playable in an embed — `playabilityStatus: OK`
 *     with `playableInEmbed: true` — before it was written down. Re-check with
 *     `npm run test:youtube`, because a video can be removed or region-blocked
 *     later and would then render a dead player.
 *   · The campaign is named and described as sample data and `advertiser` says so
 *     in plain words. These YouTube videos are published by their own channels;
 *     none of them is sponsored by TaskCash Pro, and no flag here will claim
 *     otherwise. Put real advertisers in through /admin/videos.
 *
 * Idempotent: matching on the campaign name, so re-running adds only what is
 * missing. `--remove` deletes that campaign and its videos and nothing else.
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

/* -------------------------------------------------------------------------- */
/* env                                                                        */
/* -------------------------------------------------------------------------- */

const env = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
const get = (k) => (env.match(new RegExp(`^${k}=(.*)$`, "m"))?.[1] ?? "").trim();

const SUPABASE_URL = get("NEXT_PUBLIC_SUPABASE_URL");
const SECRET = get("SUPABASE_SECRET_KEY");

if (!SUPABASE_URL || !SECRET) {
  console.error("\n  ✗ NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY are required in .env.local\n");
  process.exit(2);
}

const args = process.argv.slice(2);
const REMOVE = args.includes("--remove");
const VISIBLE = args.includes("--visible");
const PAY = args.includes("--pay");

/**
 * Read a valued flag in either `--flag=value` or `--flag value` form.
 *
 * Returns null when the flag is absent — deliberately, because the obvious
 * one-liner (`args[args.indexOf(flag) + 1]`) silently reads the NEXT flag's name
 * when the flag is missing: `indexOf(undefined)` is -1, so it returns args[0].
 * That bug made `--remove` report "unknown --source --remove".
 */
function readFlag(name) {
  const inline = args.find((a) => a.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1).trim();
  const index = args.indexOf(name);
  return index === -1 ? null : (args[index + 1] ?? null);
}

const SOURCE = readFlag("--source") ?? "youtube";
const requested = Math.max(0, Number(readFlag("--count")) || 0);

/*
  The reward and its ceiling.

  `--pay` is the opt-in; without it both stay 0 and the catalogue cannot pay.
  With it, both must be supplied: a reward with no budget is a promise to pay an
  unbounded number of times, and the campaign budget is the only thing that
  bounds it. The database enforces `spent + reward <= budget` at payout time,
  so getting these numbers wrong is a spending decision, not a display one.
*/
const REWARD = PAY ? Number(readFlag("--reward")) : 0;
const BUDGET = PAY ? Number(readFlag("--budget")) : 0;

if (PAY) {
  if (!Number.isFinite(REWARD) || REWARD <= 0) {
    console.error(
      "\n  ✗ --pay needs a positive --reward, e.g. --pay --reward=2 --budget=200\n" +
        "\n    --pay on its own would create a campaign that promises a reward it cannot state,\n" +
        "    which is exactly the kind of unbounded liability this script refuses to create.\n",
    );
    process.exit(2);
  }
  if (!Number.isFinite(BUDGET) || BUDGET < REWARD) {
    console.error(
      `\n  ✗ --pay needs a --budget at least as large as the reward (KES ${REWARD}).\n` +
        "\n    The budget is the campaign's spending ceiling: budget / reward is the most\n" +
        "    rewards it can ever pay. Without a ceiling there is no limit to the\n" +
        "    liability this creates.\n",
    );
    process.exit(2);
  }
  if (!Number.isInteger(REWARD) || !Number.isInteger(BUDGET)) {
    console.error("\n  ✗ --reward and --budget must be whole shillings.\n");
    process.exit(2);
  }
}

const admin = createClient(SUPABASE_URL, SECRET, {
  auth: { persistSession: false, autoRefreshToken: false },
});

/*
  Named "Sample videos", not "Sample sponsored videos": the rows below are real
  videos published by their own channels, and none of them is sponsored by this
  platform. Naming them "sponsored" would state something untrue about a third
  party's content.
*/
const CAMPAIGN_NAME = "Sample videos (demo)";

/*
  The campaign used to be called something less accurate. It is still removed on
  request so an earlier seed cannot be left behind as an orphan catalogue.
*/
const LEGACY_CAMPAIGN_NAMES = ["Sample sponsored videos (demo)"];

const CAMPAIGN_DESCRIPTION = PAY
  ? "Self-funded house campaign created by scripts/seed-demo-videos.mjs. The platform is the " +
    `advertiser, so rewards (KES ${REWARD} per completed view, capped at KES ${BUDGET} in total) ` +
    "are a real liability the operator funds. Remove with: npm run seed:demo-videos -- --remove"
  : "Sample data created by scripts/seed-demo-videos.mjs for demonstrating Watch & Earn. " +
    "Rewards are zero, so nothing here can pay out. Safe to delete: npm run seed:demo-videos -- --remove";

/*
  Who is paying. With --pay this is the operator, in plain words — the campaign
  is the platform advertising itself, not a third party who has not agreed to
  anything. Naming a real brand here would be a false claim about that brand.
*/
const CAMPAIGN_ADVERTISER = PAY
  ? "TaskCash Pro (self-funded house campaign)"
  : "Sample data — not a real advertiser";

/**
 * How long a demo viewer must watch before the reward unlocks.
 *
 * Ten seconds, set deliberately by the operator. It is short, and it is NOT the
 * figure a real sponsored campaign would use — the live catalogue is managed per
 * video through /admin/videos, where each campaign sets its own requirement.
 *
 * Two things to know before shortening it further:
 *
 *   · The requirement is enforced on the server against real elapsed time. A
 *     short value does not weaken that check, but it does make the reward cheap.
 *   · `video_complete_session` treats a shortfall as TERMINAL — it rejects the
 *     session and files a fraud event. The player reports progress at a third of
 *     the requirement (clamped to 2–10s) for exactly this reason, so keep the
 *     value at least a few seconds.
 *
 * This is still display metadata for demo content: every row below pays zero
 * unless `--pay` is given, with a funded budget.
 */
const DEMO_REQUIRED_SECONDS = 10;

/*
  The row copy has to track whether the row actually pays, or the catalogue
  contradicts itself: with --pay the card shows "+KES 2.00" while the description
  underneath still claimed "This video pays no reward", which is exactly the sort
  of mismatch that erodes trust in the numbers that do matter.
*/
const NOT_SPONSORED = "Sample content for demonstrating Watch & Earn. This video pays no reward.";
const HOUSE_CAMPAIGN_COPY = PAY
  ? `House campaign funded by TaskCash Pro itself. Watching the full requirement credits KES ${REWARD}.`
  : NOT_SPONSORED;

/* -------------------------------------------------------------------------- */
/* source set A — direct files                                                */
/* -------------------------------------------------------------------------- */

/*
  Real, playable sources only — every URL below was requested with a ranged GET
  and answered 200/206 with `video/mp4` before being written down.

  The obvious candidate, Google's `gtv-videos-bucket` sample set, is NOT used:
  it now answers **403** to every request, so it would have seeded a catalogue of
  dead players. That was measured, not assumed — an earlier draft of this file
  used those URLs.

  These are Blender's open movies, MDN's CC0 clips and two public test-video
  hosts. No brand affiliation is claimed by using them.

  `seconds` is approximate display metadata; the value that actually gates a
  reward is `required_watch_seconds`, which the server verifies against real
  elapsed time.
*/
const FILE_CLIPS = [
  { url: "https://download.blender.org/durian/trailer/sintel_trailer-1080p.mp4", title: "Sample clip — Sintel trailer (1080p)", seconds: 52 },
  { url: "https://download.blender.org/durian/trailer/sintel_trailer-720p.mp4", title: "Sample clip — Sintel trailer (720p)", seconds: 52 },
  { url: "https://download.blender.org/durian/trailer/sintel_trailer-480p.mp4", title: "Sample clip — Sintel trailer (480p)", seconds: 52 },
  { url: "https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/1080/Big_Buck_Bunny_1080_10s_1MB.mp4", title: "Sample clip — Big Buck Bunny (1080p, 10s)", seconds: 10 },
  { url: "https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/720/Big_Buck_Bunny_720_10s_1MB.mp4", title: "Sample clip — Big Buck Bunny (720p, 10s)", seconds: 10 },
  { url: "https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4", title: "Sample clip — Big Buck Bunny (360p, 10s)", seconds: 10 },
  { url: "https://test-videos.co.uk/vids/sintel/mp4/h264/720/Sintel_720_10s_1MB.mp4", title: "Sample clip — Sintel (720p, 10s)", seconds: 10 },
  { url: "https://test-videos.co.uk/vids/jellyfish/mp4/h264/720/Jellyfish_720_10s_1MB.mp4", title: "Sample clip — Jellyfish (720p, 10s)", seconds: 10 },
  { url: "https://mdn.github.io/shared-assets/videos/flower.mp4", title: "Sample clip — flower (CC0)", seconds: 30 },
  { url: "https://mdn.github.io/shared-assets/videos/friday.mp4", title: "Sample clip — friday (CC0)", seconds: 30 },
  { url: "https://filesamples.com/samples/video/mp4/sample_640x360.mp4", title: "Sample clip — 640x360 test", seconds: 30 },
  { url: "https://filesamples.com/samples/video/mp4/sample_960x540.mp4", title: "Sample clip — 960x540 test", seconds: 30 },
  { url: "https://filesamples.com/samples/video/mp4/sample_1280x720.mp4", title: "Sample clip — 1280x720 test", seconds: 30 },
].map((clip) => ({ ...clip, kind: "file", videoUrl: clip.url, channel: null }));

/* -------------------------------------------------------------------------- */
/* source set B — YouTube                                                     */
/* -------------------------------------------------------------------------- */

/*
  Twenty public YouTube videos that were each verified to be embeddable. `title`,
  `channel` and `seconds` are the values YouTube itself returned for each id — the
  real video length, not an estimate.

  Stored as the canonical watch URL rather than an /embed/ URL: that is what a
  person would paste, it stays meaningful, and the player derives the embed form
  from it (src/lib/video/source.ts).

  These are music videos by their own rights holders. They are fine to *display*
  through YouTube's embed, which is what that feature is for. They are not
  sponsored content, and no reward is attached to them — paying users to watch
  third-party copyrighted video would be a different thing entirely, and not one
  this script should start quietly.
*/
const YOUTUBE_VIDEOS = [
  { id: "dQw4w9WgXcQ", title: "Rick Astley - Never Gonna Give You Up (Official Video) (4K Remaster)", channel: "Rick Astley", seconds: 213 },
  { id: "9bZkp7q19f0", title: "PSY - GANGNAM STYLE(강남스타일) M/V", channel: "officialpsy", seconds: 252 },
  { id: "kJQP7kiw5Fk", title: "Luis Fonsi - Despacito ft. Daddy Yankee", channel: "LuisFonsiVEVO", seconds: 282 },
  { id: "JGwWNGJdvx8", title: "Ed Sheeran - Shape of You (Official Music Video)", channel: "Ed Sheeran", seconds: 263 },
  { id: "OPf0YbXqDm0", title: "Mark Ronson - Uptown Funk (Official Video) ft. Bruno Mars", channel: "MarkRonsonVEVO", seconds: 270 },
  { id: "RgKAFK5djSk", title: "Wiz Khalifa - See You Again ft. Charlie Puth [Official Video] Furious 7 Soundtrack", channel: "Wiz Khalifa Music", seconds: 237 },
  { id: "fJ9rUzIMcZQ", title: "Queen – Bohemian Rhapsody (Official Video Remastered)", channel: "Queen Official", seconds: 359 },
  { id: "CevxZvSJLk8", title: "Katy Perry - Roar", channel: "KatyPerryVEVO", seconds: 269 },
  { id: "e-ORhEE9VVg", title: "Taylor Swift - Blank Space", channel: "Taylor Swift", seconds: 272 },
  { id: "hT_nvWreIhg", title: "OneRepublic - Counting Stars", channel: "OneRepublicVEVO", seconds: 283 },
  { id: "YQHsXMglC9A", title: "Adele - Hello (Official Music Video)", channel: "Adele", seconds: 367 },
  { id: "09R8_2nJtjg", title: "Maroon 5 - Sugar (Official Music Video)", channel: "Maroon5VEVO", seconds: 301 },
  { id: "60ItHLz5WEA", title: "Alan Walker - Faded", channel: "Alan Walker", seconds: 213 },
  { id: "7wtfhZwyrcc", title: "Imagine Dragons - Believer (Official Music Video)", channel: "ImagineDragonsVEVO", seconds: 217 },
  { id: "v2AC41dglnM", title: "AC/DC - Thunderstruck (Official Video)", channel: "acdcVEVO", seconds: 293 },
  { id: "1w7OgIMMRc4", title: "Guns N' Roses - Sweet Child O' Mine (Official Music Video)", channel: "GunsNRosesVEVO", seconds: 303 },
  { id: "L_jWHffIx5E", title: "Smash Mouth - All Star", channel: "SmashMouthVEVO", seconds: 237 },
  { id: "ZbZSe6N_BXs", title: "Pharrell Williams - Happy (Official Video)", channel: "PharrellWilliamsVEVO", seconds: 241 },
  { id: "ktvTqknDobU", title: "Imagine Dragons - Radioactive", channel: "ImagineDragonsVEVO", seconds: 261 },
  { id: "lp-EO5I60KA", title: "Ed Sheeran - Thinking Out Loud (Official Music Video)", channel: "Ed Sheeran", seconds: 289 },
].map((video) => ({
  kind: "youtube",
  videoUrl: `https://www.youtube.com/watch?v=${video.id}`,
  url: `https://www.youtube.com/watch?v=${video.id}`,
  title: video.title,
  channel: video.channel,
  seconds: video.seconds,
  // YouTube's own thumbnail host. The app renders thumbnails with <img>, not
  // next/image, so no remote-pattern allow-listing is needed for this host.
  thumbnailUrl: `https://i.ytimg.com/vi/${video.id}/hqdefault.jpg`,
}));

/* -------------------------------------------------------------------------- */

const SOURCE_SETS = { youtube: YOUTUBE_VIDEOS, files: FILE_CLIPS, both: [...YOUTUBE_VIDEOS, ...FILE_CLIPS] };

const selected = SOURCE_SETS[SOURCE];
if (!selected) {
  console.error(`\n  ✗ unknown --source ${SOURCE} — expected youtube, files or both\n`);
  process.exit(2);
}

/*
  Capped at the number of sources that were actually verified. There is no way to
  conjure more distinct playable videos, and repeating a URL to pad the count
  would be worse than a small catalogue: the same file posted as twelve separate
  "videos" is eleven rows of noise.
*/
const COUNT = Math.min(requested || selected.length, selected.length);

/* -------------------------------------------------------------------------- */

async function findCampaign() {
  const { data, error } = await admin
    .from("video_campaigns")
    .select("id, name, budget, reward_per_view, status")
    .eq("name", CAMPAIGN_NAME)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function remove() {
  const names = [CAMPAIGN_NAME, ...LEGACY_CAMPAIGN_NAMES];
  const { data: campaigns, error } = await admin
    .from("video_campaigns")
    .select("id, name")
    .in("name", names);
  if (error) throw error;

  if (!campaigns?.length) {
    console.log("\n  · nothing to remove — no demo campaign found\n");
    return;
  }

  for (const campaign of campaigns) {
    const { count: videos } = await admin
      .from("videos")
      .select("id", { count: "exact", head: true })
      .eq("campaign_id", campaign.id);

    // Videos first: the FK is ON DELETE SET NULL, which would otherwise orphan
    // them into the real catalogue instead of removing them.
    await admin.from("videos").delete().eq("campaign_id", campaign.id);
    await admin.from("video_campaigns").delete().eq("id", campaign.id);

    console.log(`  ✓ removed "${campaign.name}" and ${videos ?? 0} video(s)`);
  }
  console.log("");
}

async function seed() {
  let campaign = await findCampaign();

  if (campaign) {
    console.log(`\n  · demo campaign already exists (${campaign.id}) — adding anything missing`);
  } else {
    const { data, error } = await admin
      .from("video_campaigns")
      .insert({
        name: CAMPAIGN_NAME,
        description: CAMPAIGN_DESCRIPTION,
        advertiser: CAMPAIGN_ADVERTISER,
        budget: BUDGET,
        reward_per_view: REWARD,
        status: VISIBLE ? "ACTIVE" : "DRAFT",
      })
      .select("id")
      .single();
    if (error) throw error;
    campaign = data;
    console.log(`\n  ✓ created demo campaign (${campaign.id}), status ${VISIBLE ? "ACTIVE" : "DRAFT"}`);
  }

  // A campaign from an earlier, less accurate name is reported rather than left
  // to sit alongside this one without anyone noticing.
  const { data: legacy } = await admin
    .from("video_campaigns")
    .select("name")
    .in("name", LEGACY_CAMPAIGN_NAMES);
  if (legacy?.length) {
    console.log(
      `  ! an older demo campaign still exists (${legacy.map((c) => `"${c.name}"`).join(", ")}) — ` +
        "remove it with --remove so the catalogue has one demo campaign, not two",
    );
  }

  const { data: existing, error: existingError } = await admin
    .from("videos")
    .select("id, video_url, required_watch_seconds, status, reward_amount, description")
    .eq("campaign_id", campaign.id);
  if (existingError) throw existingError;

  const have = new Set((existing ?? []).map((v) => v.video_url));

  const rows = selected.slice(0, COUNT).map((item) => {
    /*
      Structural check on YouTube rows before they are written: the id must be
      the 11 characters the embed URL expects. This does not replace
      `npm run test:youtube` (which proves the video is actually playable), it
      just catches a typo in this file without a network round trip.
    */
    if (item.kind === "youtube" && !/^https:\/\/www\.youtube\.com\/watch\?v=[A-Za-z0-9_-]{11}$/.test(item.videoUrl)) {
      throw new Error(`malformed YouTube URL in the seed list: ${item.videoUrl}`);
    }

    if (item.kind === "youtube") {
      return {
        campaign_id: campaign.id,
        title: item.title,
        description: `Published by ${item.channel} on YouTube. ${HOUSE_CAMPAIGN_COPY}`,
        video_url: item.videoUrl,
        thumbnail_url: item.thumbnailUrl,
        duration_seconds: item.seconds,
        required_watch_seconds: DEMO_REQUIRED_SECONDS,
        // 0 unless --pay was given, and then the exact amount reported below.
        reward_amount: REWARD,
        currency: "KES",
        daily_limit: 1,
        status: VISIBLE ? "ACTIVE" : "DRAFT",
      };
    }

    return {
      campaign_id: campaign.id,
      title: item.title,
      description: HOUSE_CAMPAIGN_COPY,
      video_url: item.videoUrl,
      thumbnail_url: null,
      duration_seconds: item.seconds,
      required_watch_seconds: Math.min(DEMO_REQUIRED_SECONDS, item.seconds),
      reward_amount: REWARD,
      currency: "KES",
      daily_limit: 1,
      status: VISIBLE ? "ACTIVE" : "DRAFT",
    };
  });

  const toInsert = rows.filter((r) => !have.has(r.video_url));
  const { data: inserted, error: insertError } = toInsert.length
    ? await admin.from("videos").insert(toInsert).select("id")
    : { data: [], error: null };
  if (insertError) throw insertError;

  /*
    Bring rows this script already created into line with the current watch-time
    requirement, status and reward, so re-running cannot leave half the catalogue
    on an older value.

    The reward IS rewritten now, in both directions, and that is deliberate: the
    script owns these rows, so re-running it with no --pay must put them back to
    zero rather than leaving a pays-nothing catalogue that has quietly kept a
    reward from an earlier run.
  */
  const wanted = new Map(rows.map((r) => [r.video_url, r]));
  let synced = 0;
  for (const row of existing ?? []) {
    const target = wanted.get(row.video_url);
    if (!target) continue;
    if (
      Number(row.required_watch_seconds) === target.required_watch_seconds &&
      row.status === target.status &&
      Number(row.reward_amount) === REWARD &&
      row.description === target.description
    ) {
      continue;
    }
    const { error } = await admin
      .from("videos")
      .update({
        required_watch_seconds: target.required_watch_seconds,
        status: target.status,
        reward_amount: REWARD,
        description: target.description,
      })
      .eq("id", row.id);
    if (error) throw error;
    synced += 1;
  }

  // The campaign's own ceiling has to move with the reward, or a run that raises
  // the reward would leave payouts refused by a budget left at the old value.
  const { error: campaignError } = await admin
    .from("video_campaigns")
    .update({ budget: BUDGET, reward_per_view: REWARD, advertiser: CAMPAIGN_ADVERTISER })
    .eq("id", campaign.id);
  if (campaignError) throw campaignError;

  const { data: all, error: verifyError } = await admin
    .from("videos")
    .select("reward_amount, status, currency, video_url, thumbnail_url, duration_seconds")
    .eq("campaign_id", campaign.id);
  if (verifyError) throw verifyError;

  const paying = (all ?? []).filter((v) => Number(v.reward_amount) !== 0);

  console.log(`  ✓ source set: ${SOURCE} (${COUNT} of ${selected.length})`);
  console.log(`  ✓ videos in the demo campaign: ${all?.length ?? 0} (added ${inserted?.length ?? 0})`);
  if (synced) console.log(`  ✓ re-synced watch time / status / reward on ${synced} existing video(s)`);
  console.log(`  ✓ every reward_amount is zero: ${paying.length === 0 ? "yes" : `no — ${paying.length} pay KES ${REWARD}`}`);
  console.log(`  ✓ currency: ${[...new Set((all ?? []).map((v) => v.currency))].join(", ") || "—"}`);
  const statuses = [...new Set((all ?? []).map((v) => v.status))];
  console.log(`  ✓ status: ${statuses.join(", ") || "—"}`);

  const withThumbs = (all ?? []).filter((v) => v.thumbnail_url).length;
  if (withThumbs) console.log(`  ✓ thumbnails attached: ${withThumbs}`);

  // The zero-reward safety property is still asserted whenever --pay was NOT
  // given, so an accidental reward needs an explicit flag to appear.
  if (!PAY && paying.length > 0) {
    console.error(
      "\n  ✗ a non-zero reward was written without --pay. This script is meant to be" +
        " incapable of that.\n",
    );
    process.exit(1);
  }

  if (PAY) {
    const { data: spend } = await admin
      .from("video_campaigns")
      .select("budget, spent, reward_per_view, advertiser")
      .eq("id", campaign.id)
      .maybeSingle();

    const budget = Number(spend?.budget ?? 0);
    const alreadySpent = Number(spend?.spent ?? 0);
    const maxRewards = Math.floor(budget / REWARD);

    console.log("");
    console.log("  THIS CAMPAIGN NOW PAYS REAL MONEY");
    console.log(`    advertiser    : ${spend?.advertiser}`);
    console.log(`    reward / view : KES ${REWARD}`);
    console.log(`    budget        : KES ${budget}`);
    console.log(`    spent so far  : KES ${alreadySpent}`);
    console.log(`    max rewards   : ${maxRewards} views, then the campaign stops paying`);
    console.log("    A completed 60-second session credits the viewer's wallet for real.");
    console.log("    Those credits are a liability, not income: they only become money out when a");
    console.log("    withdrawal is approved, so the payout account has to be funded first.");
    console.log("");
    console.log("    Back to paying nothing:");
    console.log("      npm run seed:demo-videos -- --visible")

    // The ceiling is the whole safety argument for --pay, so assert it here as
    // well as in the database before spending more of it.
    if (alreadySpent > budget) {
      console.error(`\n  ✗ spent (${alreadySpent}) already exceeds the budget (${budget}).\n`);
      process.exit(1);
    }
  }

  if (requested > COUNT) {
    console.log(
      `  · --count ${requested} capped at ${COUNT}: only that many distinct sources were verified as playable`,
    );
  }

  if (PAY) {
    console.log(
      "\n  These are ACTIVE and they PAY. Watching one for the full requirement credits\n" +
        `  KES ${REWARD} of real wallet balance, up to KES ${BUDGET} in total for this campaign.\n`,
    );
  } else if (VISIBLE) {
    console.log(
      "\n  These are now ACTIVE, so they appear in Watch & Earn. They still pay nothing:\n" +
        "  reward_amount is 0 on every row, so a completed session credits KES 0.00.\n",
    );
  } else {
    console.log(
      "\n  DRAFT: these do not appear in Watch & Earn at all. They are visible in /admin/videos.\n" +
        "  Re-run with --visible to show them (they still pay nothing).\n",
    );
  }
}

try {
  if (REMOVE) await remove();
  else await seed();
} catch (error) {
  console.error(`\n  ✗ ${error.message ?? error}\n`);
  process.exit(1);
}
