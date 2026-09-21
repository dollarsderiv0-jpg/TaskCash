/**
 * Video source handling.
 *
 * The catalogue stores a single `video_url` per row, and that URL is not always
 * a file. A campaign may point at a direct MP4 (Blender, an S3 bucket, a
 * Supabase storage object) or at a third-party player such as YouTube. Those two
 * need different HTML elements — `<video>` cannot play a YouTube watch page, and
 * an `<iframe>` cannot play an MP4 — so the decision is made here, once, from
 * the URL itself.
 *
 * Parsing the URL rather than storing a flag keeps this migration-free: a URL
 * that is already in the database is interpreted correctly without a backfill,
 * and an administrator pasting a YouTube link into /admin/videos gets the right
 * player with no extra field to remember.
 *
 * Nothing in this module is allowed to guess. If a YouTube URL is recognised but
 * its video id cannot be read, the result is `unplayable` with a reason to show
 * the user — NOT a silent fall-through to `<video>`, which would render a
 * control that looks playable and never plays.
 */

export type VideoSource =
  | { kind: "youtube"; videoId: string; embedUrl: string }
  | { kind: "file"; url: string }
  | { kind: "unplayable"; url: string; reason: string };

/** YouTube ids are exactly 11 characters of this alphabet. */
const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;

/** Path prefixes that introduce an id: /embed/<id>, /shorts/<id>, /live/<id> … */
const YOUTUBE_PATH_PREFIXES = ["embed", "shorts", "live", "v", "e"];

function isYouTubeHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === "youtu.be" ||
    host === "youtube.com" ||
    host === "youtube-nocookie.com" ||
    host.endsWith(".youtube.com") ||
    host.endsWith(".youtube-nocookie.com")
  );
}

function readYouTubeId(url: URL): string | null {
  const host = url.hostname.toLowerCase().replace(/^www\./, "");

  // youtu.be/<id> — the id is the first path segment.
  if (host === "youtu.be") {
    const [segment] = url.pathname.split("/").filter(Boolean);
    return segment && YOUTUBE_ID.test(segment) ? segment : null;
  }

  // /watch?v=<id>
  const fromQuery = url.searchParams.get("v");
  if (fromQuery && YOUTUBE_ID.test(fromQuery)) return fromQuery;

  // /embed/<id>, /shorts/<id>, /live/<id>, /v/<id>
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length >= 2 && YOUTUBE_PATH_PREFIXES.includes(segments[0])) {
    const candidate = segments[1];
    if (candidate && YOUTUBE_ID.test(candidate)) return candidate;
  }

  return null;
}

/**
 * Classify a catalogue URL into something the player can render.
 *
 * Anything that is not a recognised YouTube URL is treated as a direct file
 * URL: the platform's own storage domains, Blender's open movies and any other
 * host all behave the same way, and that behaviour is unchanged from before this
 * helper existed.
 */
export function parseVideoSource(rawUrl: string | null | undefined): VideoSource {
  const trimmed = (rawUrl ?? "").trim();

  if (!trimmed) {
    return { kind: "unplayable", url: "", reason: "This video has no link attached." };
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return {
      kind: "unplayable",
      url: trimmed,
      reason: "This video's link is not a web address, so it cannot be played.",
    };
  }

  /*
    Only http(s) can be played. `new URL()` happily parses `javascript:` and
    `data:` values, so without this they would be passed to `<video src>` as
    though they were files. Refusing them keeps a catalogue row from holding
    something that was never a video.
  */
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return {
      kind: "unplayable",
      url: trimmed,
      reason: "This video's link must be an http or https address.",
    };
  }

  if (!isYouTubeHost(url.hostname)) {
    return { kind: "file", url: trimmed };
  }

  const videoId = readYouTubeId(url);
  if (!videoId) {
    return {
      kind: "unplayable",
      url: trimmed,
      reason:
        "This link is a YouTube page rather than a single video. An administrator needs to " +
        "replace it with the video's own link.",
    };
  }

  /*
    `rel=0` keeps the embed from filling with unrelated recommendations after the
    video ends; `playsinline` stops iOS from hijacking playback into a fullscreen
    takeover. `autoplay` is safe here because the iframe only mounts in response
    to the user pressing "Watch now" — if a browser still blocks it, the user can
    press play in the embedded player and nothing else breaks.
  */
  /*
    `enablejsapi=1` turns on the embedded player's postMessage channel, which is
    how the watch player learns that playback actually STARTED. Without it the
    only available signal is the iframe finishing its load, and a watch session
    opened at load accrues earned time while the embedded player sits paused —
    including when a browser blocks autoplay. That is the mismatch the player's
    lazy session start exists to remove.
  */
  const embedUrl =
    `https://www.youtube.com/embed/${videoId}` +
    "?rel=0&playsinline=1&autoplay=1&enablejsapi=1";

  return { kind: "youtube", videoId, embedUrl };
}
