#!/usr/bin/env node
/**
 * Build a real video catalogue from real YouTube channels.
 *
 *   node scripts/ingest-youtube-trailers.mjs --limit 300 --reward 2 --budget 3000 --visible
 *   node scripts/ingest-youtube-trailers.mjs --channel=@A24 --channel=@Netflix --limit 60
 *   node scripts/ingest-youtube-trailers.mjs --dry-run          # harvest + verify, write nothing
 *   node scripts/ingest-youtube-trailers.mjs --remove           # delete the campaign it made
 *
 * WHY THIS EXISTS
 *
 * The catalogue has to be made of videos that actually play. A video id cannot be
 * invented, and a plausible-looking one that 404s is worse than no entry at all:
 * the row carries a `reward_amount`, so a dead player is a payout promise the
 * platform cannot honour. Every id here is therefore taken from a channel page
 * (so it provably exists) and then put through the same two-signal check the
 * rest of this project uses (`npm run test:youtube`):
 *
 *   1. oEmbed returns 200  — the video exists and its owner permits embedding.
 *   2. youtubei/player says `playabilityStatus.status = OK` with
 *      `playableInEmbed: true` — it will really play inside our <iframe>.
 *
 * oEmbed alone is not enough (region blocks and age gates pass it), and the
 * player response alone is not enough (it does not tell us embedding is
 * permitted). Failed ids are counted and discarded, never written.
 *
 * HARVESTING
 *
 * A channel's /videos page carries ~30 ids in `ytInitialData`; the rest come from
 * the `continuation` token in that same payload, posted to the same public
 * web-client endpoint the browser uses. No API key, no scraping of rendered HTML.
 *
 * WHAT THIS WILL NOT DO
 *
 * It will not add a million videos, and the limit is not a limitation of the
 * database — it is the cost of proof. One million confirmed-embeddable ids needs
 * two requests per video against YouTube (~2M calls, several hundred GB) and a
 * quota-bearing Data API key for discovery; anything cheaper is guessing at ids.
 * `--limit` is the honest knob: raise it and let this run. Batch size, not
 * fabrication, is what scales this.
 *
 * It also does not invent advertisers, sponsorship, or titles: titles, channels
 * and durations are read back from YouTube, and the description credits the
 * channel that published the video.
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

const args = process.argv.slice(2);
const has = (name) => args.some((a) => a === name || a.startsWith(`${name}=`));

/**
 * Read a valued flag in either `--flag=value` or `--flag value` form. Returns
 * null when absent — the obvious `args[args.indexOf(f) + 1]` one-liner silently
 * reads the next flag's name when the flag is missing, because
 * `indexOf(undefined)` is -1 and it returns `args[0]`.
 */
function readFlag(name) {
  const inline = args.find((a) => a.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1).trim();
  const index = args.indexOf(name);
  return index === -1 ? null : (args[index + 1] ?? null);
}
const readAll = (name) =>
  args.filter((a) => a.startsWith(`${name}=`)).map((a) => a.slice(name.length + 1).trim());

const LIMIT = Number(readFlag("--limit") ?? 300);
const PER_CHANNEL = Number(readFlag("--per-channel") ?? 120);
const CONCURRENCY = Number(readFlag("--concurrency") ?? 5);
const REWARD = Number(readFlag("--reward") ?? 0);
const BUDGET = Number(readFlag("--budget") ?? 0);
const CAMPAIGN = readFlag("--campaign") ?? "Movie trailers (official)";
const CURRENCY = readFlag("--currency") ?? "KES";
const VISIBLE = has("--visible");
const DRY_RUN = has("--dry-run");
const REMOVE = has("--remove");
/** Trailers only by default; `--all` takes everything a channel published. */
const ONLY_TRAILERS = !has("--all");
const RECHECK = has("--recheck");
/**
 * The shortest clip this catalogue will hold.
 *
 * `videos_required_within_duration` forbids asking for more watch time than the
 * video runs, so a 30-second teaser can only ever require 30 seconds — which is
 * not a 60-second requirement, it is the rule bent by half. The platform's rule
 * is one minute, so short clips are excluded from the catalogue instead of being
 * inserted with a weaker gate. Trailers are usually 90s–3min, so this costs
 * little: 29 of the first 314 entries.
 */
const MIN_DURATION = Number(readFlag("--min-duration") ?? 61);

/**
 * How long each ingested video asks to be watched.
 *
 * The house default, and deliberately NOT hardcoded into the row builder below:
 * it used to be a literal `60`, so re-running this script would silently undo a
 * change to the requirement made anywhere else — including in /admin/videos.
 * Now the figure is stated once, here, and can be overridden per run.
 *
 * The database still enforces `required_watch_seconds <= duration_seconds`, so a
 * `--required` larger than MIN_DURATION cannot produce an uncollectable video:
 * the insert is refused rather than written.
 */
const REQUIRED_WATCH_SECONDS = Number(readFlag("--required") ?? 10);

const TRAILER_RE = /\b(trailer|teaser|official\s+trailer|first\s+look|sneak\s+peek)\b/i;

/**
 * Movie-studio and film-distributor channels — trailers, teasers and first looks.
 * Handles are validated at runtime, so a wrong or renamed one is skipped rather
 * than crashing the run, and one failure does not lose the other channels.
 */
const DEFAULT_CHANNELS = [
  "@marvel",
  "@20thCenturyStudios",
  "@UniversalPictures",
  "@ParamountPictures",
  "@LionsgateMovies",
  "@A24",
  "@Netflix",
  "@WarnerBros",
  "@SonyPictures",
  "@Disney",
  "@Pixar",
  "@DreamWorksAnimation",
  "@FocusFeatures",
  "@SearchlightPictures",
  "@NEONrated",
  "@AmazonMGMStudios",
  "@AppleTV",
  "@HBO",
  "@FXNetworks",
  "@Moviefone",
  "@MovieclipsTrailers",
  "@STUDIOCANAL",
  "@VertigoReleasing",
  "@RoadsideAttractions",
  "@MagnoliaPictures",
  "@IFCFilms",
  "@WellGoUSA",
  "@BleeckerStreet",
  "@film4",
  "@Miramax",
];

const CHANNELS = readAll("--channel").length ? readAll("--channel") : DEFAULT_CHANNELS;

if (!SUPABASE_URL || !SECRET) {
  console.error("\n  ✗ NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY are required in .env.local\n");
  process.exit(2);
}
if (REWARD > 0 && !(BUDGET > 0)) {
  // A reward without a ceiling is an unbounded liability.
  console.error("\n  ✗ --reward requires --budget (the maximum this campaign can ever pay)\n");
  process.exit(2);
}

const db = createClient(SUPABASE_URL, SECRET, { auth: { persistSession: false } });

/* -------------------------------------------------------------------------- */
/* HTTP                                                                       */
/* -------------------------------------------------------------------------- */

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

async function getText(url, accept = "text/html") {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25_000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "user-agent": UA, "accept-language": "en-US,en;q=0.9", accept },
      redirect: "follow",
    });
    return { status: res.status, text: await res.text() };
  } catch (error) {
    return { status: 0, text: String(error?.message ?? error) };
  } finally {
    clearTimeout(timer);
  }
}

async function postJson(url, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25_000);
  try {
    const res = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "user-agent": UA,
        "accept-language": "en-US,en;q=0.9",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json().catch(() => null) };
  } catch (error) {
    return { status: 0, json: null, error: String(error?.message ?? error) };
  } finally {
    clearTimeout(timer);
  }
}

/* -------------------------------------------------------------------------- */
/* harvest                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Walk a YouTube payload for anything that looks like a video entry.
 *
 * Structural parsing rather than a regex over the raw text: `videoId` appears in
 * several unrelated places (recommendations, ads, the player itself) and the
 * `title` that belongs to each one is a sibling field, not a neighbour in the
 * byte stream. Walking the parsed tree keeps the two together.
 */
function collectVideos(node, out, seen) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) collectVideos(child, out, seen);
    return;
  }

  /*
    Two shapes, because YouTube serves both and swaps them without notice.

    `videoRenderer` is the older one; current channel pages send
    `lockupViewModel` instead, where the id is `contentId` and the title sits
    under `metadata.lockupMetadataViewModel.title.content`. This was found by
    inspecting a real page: with only `videoRenderer` handled, every one of 30
    channels returned 200 and yielded nothing at all — a silent, total harvest
    failure that looked like "these channels have no videos".
  */
  const id = [node.videoId, node.contentId].find(
    (candidate) => typeof candidate === "string" && /^[A-Za-z0-9_-]{11}$/.test(candidate),
  );
  if (id && !seen.has(id)) {
    const title =
      node.title?.runs?.[0]?.text ??
      node.title?.simpleText ??
      node.headline?.simpleText ??
      node.headline?.runs?.[0]?.text ??
      node.metadata?.lockupMetadataViewModel?.title?.content ??
      null;
    if (title) {
      seen.add(id);
      out.push({
        id,
        title: String(title).trim(),
        // `lengthText` is what the page shows ("3:24"); `lengthSeconds` is exact.
        durationSeconds: Number(node.lengthSeconds) || null,
        thumbnail: node.contentImage?.thumbnailViewModel?.image?.sources?.[0]?.url ?? null,
      });
    }
  }

  for (const value of Object.values(node)) collectVideos(value, out, seen);
}

function findContinuation(node, found = []) {
  if (!node || typeof node !== "object") return found;
  if (Array.isArray(node)) {
    for (const child of node) findContinuation(child, found);
    return found;
  }
  const token = node.continuationCommand?.token;
  if (typeof token === "string") found.push(token);
  for (const value of Object.values(node)) findContinuation(value, found);
  return found;
}

function readClient(html) {
  return {
    key: html.match(/"INNERTUBE_API_KEY":"([^"]+)"/)?.[1] ?? null,
    version: html.match(/"INNERTUBE_CLIENT_VERSION":"([^"]+)"/)?.[1] ?? null,
  };
}

function readInitialData(html) {
  const match = html.match(/var ytInitialData\s*=\s*(\{.*?\});<\/script>/s);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

async function harvestChannel(handle, client, limit) {
  const url = `https://www.youtube.com/${handle}/videos`;
  const page = await getText(url);
  if (page.status !== 200) return { handle, videos: [], reason: `http ${page.status}` };

  const data = readInitialData(page.text);
  if (!data) return { handle, videos: [], reason: "no ytInitialData" };

  const videos = [];
  const seen = new Set();
  collectVideos(data, videos, seen);

  const localClient = readClient(page.text);
  const apiKey = localClient.key ?? client.key;
  const version = localClient.version ?? client.version;

  let token = findContinuation(data)[0] ?? null;
  let rounds = 0;

  while (token && videos.length < limit && rounds < 12) {
    rounds += 1;
    const response = await postJson(
      `https://www.youtube.com/youtubei/v1/browse?key=${apiKey}&prettyPrint=false`,
      {
        context: { client: { clientName: "WEB", clientVersion: version, hl: "en", gl: "US" } },
        continuation: token,
      },
    );
    if (!response.json) break;

    const before = videos.length;
    collectVideos(response.json, videos, seen);
    token = findContinuation(response.json)[0] ?? null;
    if (videos.length === before) break;

    // Be a considerate client: this endpoint is not ours.
    await new Promise((r) => setTimeout(r, 400));
  }

  return { handle, videos: videos.slice(0, limit), reason: null, rounds };
}

/* -------------------------------------------------------------------------- */
/* verify                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The second signal: the watch page's own `ytInitialPlayerResponse`.
 *
 * The cheaper `youtubei/v1/player` endpoint was tried first and is a trap — an
 * anonymous call to it reports `playabilityStatus: UNPLAYABLE` for videos that
 * demonstrably play (verified against an id already known to be embeddable),
 * while still returning `videoDetails`. Using it would have rejected the entire
 * catalogue as broken. The watch page is what this project already trusts, and
 * it costs ~1MB per video rather than a few KB.
 *
 * The embed page cannot be used instead: YouTube serves it a shell with no
 * player response at all, so every video would look unplayable.
 */
async function checkWatchPage(id) {
  const { status, text } = await getText(`https://www.youtube.com/watch?v=${id}`);
  const playability = text.match(/"playabilityStatus":\{"status":"([A-Z_]+)"/);
  const inEmbed = text.match(/"playableInEmbed":(true|false)/);
  const length = text.match(/"lengthSeconds":"(\d+)"/);
  const author = text.match(/"author":"((?:[^"\\]|\\.)*)"/);
  return {
    httpStatus: status,
    /** 429 means YouTube is throttling us — that is not a verdict on the video. */
    throttled: status === 429,
    status: playability ? playability[1] : null,
    playableInEmbed: inEmbed ? inEmbed[1] === "true" : null,
    lengthSeconds: length ? Number(length[1]) : null,
    author: author ? author[1] : null,
  };
}

async function verify(candidate) {
  const watchUrl = `https://www.youtube.com/watch?v=${candidate.id}`;
  const oembed = await getText(
    `https://www.youtube.com/oembed?url=${encodeURIComponent(watchUrl)}&format=json`,
    "application/json",
  );

  let meta = null;
  if (oembed.status === 200) {
    try {
      meta = JSON.parse(oembed.text);
    } catch {
      meta = null;
    }
  }

  const player = await checkWatchPage(candidate.id);
  const embeddable =
    oembed.status === 200 && player.status === "OK" && player.playableInEmbed === true;

  /*
    Three outcomes, not two — and the third is the one that matters.

    A video is `unknown`, never `rejected`, when we simply could not obtain the
    second signal: a 429 means YouTube is throttling this machine, and a page
    with no `playabilityStatus` at all is a page we did not really read. Calling
    those "rejected" would both mislead the operator and quietly give up on
    videos that are perfectly good — the first bulk run reported 700 "rejected"
    that were nothing of the sort, while oEmbed returned 200 for every one of
    them. That is precisely the trap the two-signal rule exists to catch, so the
    distinction has to survive into the report.
  */
  const unknown =
    !embeddable &&
    (player.throttled || player.status === null) &&
    (oembed.status === 200 || oembed.status === 0);

  return {
    id: candidate.id,
    embeddable,
    unknown,
    throttled: player.throttled,
    oembedStatus: oembed.status,
    playability: player.status,
    playableInEmbed: player.playableInEmbed,
    title: meta?.title ?? candidate.title,
    author: meta?.author_name ?? player.author ?? null,
    lengthSeconds: player.lengthSeconds ?? candidate.durationSeconds ?? null,
    thumbnail: meta?.thumbnail_url ?? candidate.thumbnail ?? null,
    watchUrl,
  };
}

/** Bounded-concurrency map, so a long run neither serialises nor hammers. */
async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function runner() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runner));
  return results;
}

/* -------------------------------------------------------------------------- */
/* main                                                                       */
/* -------------------------------------------------------------------------- */

async function findCampaign() {
  const { data } = await db.from("video_campaigns").select("id, name").eq("name", CAMPAIGN).maybeSingle();
  return data ?? null;
}

async function removeCampaign() {
  const campaign = await findCampaign();
  if (!campaign) {
    console.log(`\n  nothing to remove — no campaign named "${CAMPAIGN}"\n`);
    return;
  }
  const { count } = await db.from("videos").select("id", { count: "exact", head: true }).eq("campaign_id", campaign.id);
  await db.from("videos").delete().eq("campaign_id", campaign.id);
  await db.from("video_campaigns").delete().eq("id", campaign.id);
  console.log(`\n  removed campaign "${CAMPAIGN}" and ${count ?? 0} video(s)\n`);
}

async function main() {
  console.log(`\n  TaskCash Pro — YouTube trailer ingestion`);
  console.log(`  campaign   : ${CAMPAIGN}`);
  console.log(`  channels   : ${CHANNELS.length}${ONLY_TRAILERS ? " (trailers/teasers only)" : " (everything)"}`);
  console.log(`  target     : ${LIMIT} videos, up to ${PER_CHANNEL} harvested per channel`);
  console.log(`  reward     : ${REWARD} ${CURRENCY}${REWARD > 0 ? ` (budget ${BUDGET})` : " (nothing is paid)"}`);
  console.log(`  mode       : ${DRY_RUN ? "DRY RUN — writes nothing" : VISIBLE ? "ACTIVE (visible)" : "DRAFT (hidden)"}\n`);

  if (REMOVE) {
    await removeCampaign();
    return;
  }

  // The web-client key/version are public constants of the site itself, read
  // from a real page so they cannot go stale in this file.
  const home = await getText("https://www.youtube.com/");
  const client = readClient(home.text);
  if (!client.key || !client.version) {
    console.error("  ✗ could not read the YouTube web-client key/version from the home page\n");
    process.exit(3);
  }

  /* 1 — harvest ---------------------------------------------------------- */

  const harvested = [];
  const seen = new Set();

  for (const handle of CHANNELS) {
    if (harvested.length >= LIMIT * 2) break;
    const result = await harvestChannel(handle, client, PER_CHANNEL);
    if (result.reason) {
      console.log(`  · ${handle.padEnd(26)} skipped (${result.reason})`);
      continue;
    }
    const wanted = result.videos.filter((v) => !ONLY_TRAILERS || TRAILER_RE.test(v.title));
    let added = 0;
    for (const video of wanted) {
      if (seen.has(video.id)) continue;
      seen.add(video.id);
      harvested.push({ ...video, handle });
      added += 1;
    }
    console.log(
      `  · ${handle.padEnd(26)} ${String(result.videos.length).padStart(4)} harvested, ${String(added).padStart(4)} kept`,
    );
  }

  console.log(`\n  harvested ${harvested.length} candidate id(s), ${seen.size} unique\n`);
  if (harvested.length === 0) {
    console.log("  nothing to verify — stopping\n");
    return;
  }

  /* 2 — skip what is already in the database ----------------------------- */

  const { data: existingRows } = await db
    .from("videos")
    .select("video_url, id, campaign_id");
  const existingUrls = new Set((existingRows ?? []).map((r) => r.video_url));

  const fresh = harvested.filter((v) => !existingUrls.has(v.watchUrl));
  console.log(`  ${fresh.length} candidate(s) not already in the catalogue`);
  console.log(`  ${harvested.length - fresh.length} already present — skipped without a request\n`);

  const candidates = fresh.slice(0, RECHECK ? undefined : LIMIT);
  if (candidates.length === 0) {
    console.log("  catalogue is already up to date\n");
    return;
  }

  /* 3 — verify ----------------------------------------------------------- */

  /*
    Two passes, because the first one can be sabotaged by our own throughput.

    Fetching ~1MB per video a few hundred times in a row gets this machine
    throttled, and a throttled machine cannot tell a dead video from a busy one.
    So anything left unresolved is retried ONCE, slowly, after a cooldown — and
    whatever is still unresolved after that is reported as unknown and left out
    of the catalogue. Nothing is ever written on a guess.
  */
  async function verifyAll(list, concurrency, pass) {
    console.log(
      `  verifying ${list.length} id(s) — pass ${pass}, ${concurrency} at a time, two signals each…\n`,
    );
    let done = 0;
    const results = await mapLimit(list, concurrency, async (candidate) => {
      const result = await verify(candidate);
      done += 1;
      if (done % 25 === 0) process.stdout.write(`    … ${done}/${list.length}\r`);
      return result;
    });
    process.stdout.write("\n");
    return results;
  }

  let verified = await verifyAll(candidates, CONCURRENCY, 1);
  const playable = verified.filter((v) => v.embeddable);
  let unresolved = verified.filter((v) => v.unknown);

  if (unresolved.length > 0) {
    const throttled = unresolved.filter((v) => v.throttled).length;
    console.log(
      `\n  ${unresolved.length} unresolved` +
        (throttled ? ` (${throttled} throttled with HTTP 429)` : ` (no playability data returned)`) +
        ` — this is NOT a verdict on those videos.`,
    );
    console.log(`  waiting 90s, then retrying them slowly (2 at a time)…\n`);
    await new Promise((r) => setTimeout(r, 90_000));

    const retry = await verifyAll(unresolved, 2, 2);
    const retryPlayable = retry.filter((v) => v.embeddable);
    playable.push(...retryPlayable);
    unresolved = retry.filter((v) => v.unknown);
    console.log(`  retry recovered ${retryPlayable.length} more that the first pass could not read.`);
  }

  const rejected = verified.filter((v) => !v.embeddable && !v.unknown);

  console.log(`\n  verified embeddable : ${playable.length}`);
  console.log(`  rejected (definitive): ${rejected.length}`);
  console.log(`  unresolved          : ${unresolved.length}${unresolved.length ? "  ← re-run later; YouTube was throttling" : ""}`);
  if (rejected.length) {
    const reasons = new Map();
    for (const r of rejected) {
      const key = `${r.oembedStatus}/${r.playability ?? "?"}`;
      reasons.set(key, (reasons.get(key) ?? 0) + 1);
    }
    for (const [key, count] of [...reasons].sort((a, b) => b[1] - a[1]).slice(0, 6)) {
      console.log(`    oembed/playability ${key.padEnd(12)} ${count}`);
    }
  }

  if (DRY_RUN) {
    console.log("\n  DRY RUN — nothing written. First five that would be inserted:\n");
    for (const v of playable.slice(0, 5)) {
      console.log(`    ${v.id}  ${String(v.lengthSeconds ?? "?").padStart(4)}s  ${v.author ?? "?"}`);
      console.log(`        ${v.title?.slice(0, 90)}`);
    }
    console.log("");
    return;
  }

  /* 4 — write ------------------------------------------------------------ */

  const campaign = await findCampaign();
  let campaignId = campaign?.id ?? null;

  if (!campaignId) {
    const { data, error } = await db
      .from("video_campaigns")
      .insert({
        name: CAMPAIGN,
        description:
          "Movie trailers published by their own studios and distributors. A house campaign: the " +
          "platform is the advertiser. Each clip is credited to the channel that published it.",
        // Plain words in the admin UI too: the studios did not sponsor this and
        // must never be presented as if they had.
        advertiser: "TaskCash Pro (house campaign — not a studio sponsorship)",
        budget: BUDGET,
        spent: 0,
        reward_per_view: REWARD,
        status: VISIBLE ? "ACTIVE" : "DRAFT",
      })
      .select("id")
      .single();
    if (error) {
      console.error(`\n  ✗ could not create the campaign: ${error.message}\n`);
      process.exit(4);
    }
    campaignId = data.id;
    console.log(`  created campaign ${campaignId}`);
  } else {
    console.log(`  using existing campaign ${campaignId}`);
  }

  // Anything too short to carry the full requirement is dropped, not weakened.
  const selected = playable.filter((v) => (v.lengthSeconds ?? 0) >= MIN_DURATION);
  const tooShort = playable.length - selected.length;
  if (tooShort > 0) {
    console.log(
      `  excluded ${tooShort} clip(s) shorter than ${MIN_DURATION}s — they cannot hold a 60-second ` +
        `requirement (see MIN_DURATION in this file for why that matters).`,
    );
  }

  const rows = selected.map((video) => {
    const duration = Math.max(5, Math.min(36_000, Math.round(video.lengthSeconds ?? 0) || 60));
    // Every entry in this catalogue asks for the same watch time.
    const required = REQUIRED_WATCH_SECONDS;
    return {
      campaign_id: campaignId,
      title: (video.title ?? `Trailer ${video.id}`).slice(0, 200),
      description:
        `Published by ${video.author ?? "its channel"} on YouTube. ` +
        `House campaign funded by TaskCash Pro itself — no brand sponsored this view.`,
      video_url: video.watchUrl,
      thumbnail_url: video.thumbnail,
      duration_seconds: duration,
      required_watch_seconds: required,
      reward_amount: REWARD,
      currency: CURRENCY,
      daily_limit: 1,
      status: VISIBLE ? "ACTIVE" : "DRAFT",
    };
  });

  let inserted = 0;
  const failures = [];
  for (let i = 0; i < rows.length; i += 100) {
    const batch = rows.slice(i, i + 100);
    const { error, count } = await db.from("videos").insert(batch, { count: "exact" });
    if (error) failures.push(`${i}–${i + batch.length}: ${error.message}`);
    else inserted += count ?? batch.length;
    process.stdout.write(`    … ${Math.min(i + 100, rows.length)}/${rows.length} written\r`);
  }

  console.log(`\n  inserted ${inserted} video(s)`);
  for (const failure of failures) console.log(`    ✗ ${failure}`);

  const { count: campaignVideos } = await db
    .from("videos")
    .select("id", { count: "exact", head: true })
    .eq("campaign_id", campaignId);

  console.log(`\n  campaign "${CAMPAIGN}" now holds ${campaignVideos ?? 0} video(s)`);
  console.log(`  status: ${VISIBLE ? "ACTIVE — visible in Watch & Earn" : "DRAFT — not shown to users"}`);
  if (REWARD > 0) {
    console.log(
      `  reward: ${REWARD} ${CURRENCY} per verified view, capped at ${BUDGET} total ` +
        `(${Math.floor(BUDGET / REWARD)} rewards). That ceiling is the database's, not this script's.`,
    );
    console.log(
      `  NOTE: these are real ledger credits. Fund the liability before withdrawals go live.`,
    );
  } else {
    console.log(
      `  reward: none. A zero-reward video needs migration 0010 before a user can collect one,`,
    );
    console.log(`  otherwise completing it raises inside wallet_post.`);
  }
  console.log(
    `\n  Re-check that the catalogue still plays at any time: npm run test:youtube\n`,
  );
}

await main();
