/**
 * The shape the watch list actually renders, and the one place it is derived.
 *
 * This lives outside the service because BOTH sides need it and they must agree:
 * the server component renders the first page, and the client appends further
 * pages fetched from `/api/videos`. If the two mapped rows differently, the
 * second page of cards would quietly differ from the first.
 *
 * Nothing here imports the service, so it is safe in a client bundle — the
 * service reaches for server-only Supabase clients. The input is declared
 * structurally for the same reason: a type-only import across that boundary is
 * erased at build time, but keeping the dependency out entirely means this file
 * can never drag a server module into the browser bundle by accident.
 */

export type WatchListPackage = {
  id: string;
  name: string;
  owned: boolean;
  dailyCap: number;
  earnedToday: number;
  resetsAt: string | null;
};

export type WatchListItem = {
  id: string;
  title: string;
  description: string | null;
  /**
   * The playable link.
   *
   * Sent with the CARD rather than only in the start response so the player can
   * mount before a watch session exists — which is what lets the session (and
   * with it the earned-time clock) begin at the moment playback starts rather
   * than at the moment the button is pressed. It is the same URL the service
   * already returned on start and in `/api/videos`, so nothing new is exposed.
   */
  videoUrl: string;
  rewardAmount: number;
  durationSeconds: number;
  requiredWatchSeconds: number;
  thumbnailUrl: string | null;
  campaignName: string | null;
  eligible: boolean;
  reason: string | null;
  remainingToday: number;
  rewardedToday: number;
  package: WatchListPackage | null;
};

/** The fields `toWatchListItem` reads off a service card. */
export type WatchCardSource = {
  id: string;
  title: string;
  description: string | null;
  video_url: string;
  thumbnail_url: string | null;
  duration_seconds: number;
  required_watch_seconds: number;
  reward_amount: number;
  campaign: { name: string } | null;
  eligible: boolean;
  reason: string | null;
  remainingToday: number;
  rewardedToday: number;
  package: WatchListPackage | null;
};

export function toWatchListItem(video: WatchCardSource): WatchListItem {
  return {
    id: video.id,
    title: video.title,
    description: video.description,
    videoUrl: video.video_url,
    rewardAmount: Number(video.reward_amount),
    durationSeconds: video.duration_seconds,
    requiredWatchSeconds: video.required_watch_seconds,
    thumbnailUrl: video.thumbnail_url,
    campaignName: video.campaign?.name ?? null,
    eligible: video.eligible,
    reason: video.reason,
    remainingToday: video.remainingToday,
    rewardedToday: video.rewardedToday,
    package: video.package,
  };
}
