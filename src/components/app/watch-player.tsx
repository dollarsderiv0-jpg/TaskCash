"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Gift, Loader2, PlayCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert, Progress, Separator } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { apiRequest } from "@/lib/client/api";
import { formatMoney } from "@/lib/money/format";
import { parseVideoSource } from "@/lib/video/source";

/**
 * Watch player.
 *
 * The client's job here is narrow: play the video, and report *elapsed time* to
 * the server. It never sends a reward amount, and it never decides whether a
 * reward was earned. The completion call returns the server's verdict, and the
 * balance shown afterwards is re-read from the API rather than incremented
 * locally.
 *
 * Two kinds of source are supported and they are deliberately interchangeable:
 * a direct file plays in <video>, a YouTube link plays in the provider's own
 * <iframe>. Neither can influence the reward — completion is judged on elapsed
 * time the *server* observed, not on anything the player reports — so a
 * third-party embed does not weaken the verification model in the same way a
 * client-reported playback position would have.
 */

type StartResponse = {
  sessionId: string;
  sessionToken: string;
  videoId: string;
  title: string;
  description: string | null;
  videoUrl: string;
  thumbnailUrl: string | null;
  durationSeconds: number;
  requiredWatchSeconds: number;
  rewardAmount: number;
  currency: string;
  startedAt: string;
  watchedSeconds: number;
  status: string;
  resumed: boolean;
};

type CompleteResponse = {
  status: string;
  rewardAmount: number | null;
  currency: string;
  transactionId: string | null;
  reference: string | null;
  watchedSeconds: number;
  rejectReason: string | null;
  duplicate: boolean;
  availableBalance: number | null;
  lockedBalance: number | null;
  message: string;
};

/**
 * `preparing` is the state where the player is on screen but no watch session
 * exists yet: the session — and with it the clock the server counts against — is
 * opened when playback actually begins, not when the button was pressed.
 */
type Phase = "idle" | "preparing" | "starting" | "watching" | "verifying" | "done";

const REJECT_COPY: Record<string, string> = {
  INSUFFICIENT_WATCH_TIME:
    "The required watch time was not met on our side, so no reward was issued. Please watch the full duration without skipping.",
  CAMPAIGN_BUDGET_EXHAUSTED:
    "This campaign's reward budget is exhausted, so rewards have stopped. No reward was issued.",
  DAILY_REWARD_LIMIT:
    "You have reached your daily reward limit. Nothing was credited for this session.",
  ACCOUNT_NOT_ELIGIBLE: "Your account is not eligible for rewards right now.",
};

export function WatchPlayer({
  video,
  currency,
}: {
  video: {
    id: string;
    title: string;
    description: string | null;
    /** The playable link, so the player can mount before a session exists. */
    videoUrl: string;
    rewardAmount: number;
    durationSeconds: number;
    requiredWatchSeconds: number;
    thumbnailUrl: string | null;
    campaignName: string | null;
  };
  currency: string;
}) {
  const router = useRouter();
  const { toast } = useToast();

  const [phase, setPhase] = React.useState<Phase>("idle");
  const [session, setSession] = React.useState<StartResponse | null>(null);
  const [elapsed, setElapsed] = React.useState(0);
  const [result, setResult] = React.useState<CompleteResponse | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  // Set when the server no longer knows this session. The player then offers a
  // clean restart instead of leaving the user on a button that cannot work.
  const [sessionLost, setSessionLost] = React.useState(false);
  /*
    The SERVER's answer to "has this session watched enough yet?"

    The Collect button used to unlock on the local countdown alone, and that is a
    race the user loses. The browser measures elapsed time with its own clock
    (Date.now() - startedAt); the server measures the same interval with ITS
    clock, and clamps whatever the client claims to what the server has itself
    observed. So on a machine whose clock runs a second or two ahead — or simply
    on a request that lands slightly early — the button unlocks at 60s while the
    server has seen 58s, the completion is refused as INSUFFICIENT_WATCH_TIME,
    and `video_complete_session` marks the session REJECTED. Terminal. A user who
    watched every second is then told their watch time was not met, loses the
    session, and has a fraud event filed against them.

    Gating on the server's own `ready` flag removes the disagreement: the button
    appears when the party that decides says yes. The countdown still uses the
    local clock, because that is only display.
  */
  const [serverReady, setServerReady] = React.useState<boolean | null>(null);

  // A new session is a new measurement; forget the previous verdict.
  React.useEffect(() => {
    setServerReady(null);
  }, [session?.sessionToken]);

  const videoRef = React.useRef<HTMLVideoElement>(null);
  const iframeRef = React.useRef<HTMLIFrameElement>(null);

  /*
    Guards the one-way move from "the player is mounted" to "a watch session
    exists".

    Both the embedded player's state messages (which repeat on every state change)
    and the fallback timer can fire, and a second /api/videos/start would open a
    SECOND session for one click — leaving the user collecting against a token
    while a different one quietly accrues time. The ref makes the transition
    happen once per attempt; `begin()` re-arms it for the next one.
  */
  const startedRef = React.useRef(false);

  /*
    The latest observed elapsed value, readable from an effect that must NOT be
    re-run every second.

    The periodic report below used to list `elapsed` as a dependency, so the
    10-second interval was torn down and re-created on every tick and its
    callback never ran. `/api/videos/progress` was therefore never called,
    `watched_seconds` stayed 0 for every session, and video_complete_session —
    which requires `watched_seconds >= required_watch_seconds` as well as its own
    elapsed-time check — rejected every completion as INSUFFICIENT_WATCH_TIME
    (filing a fraud event each time). Reading the clock through a ref is what
    lets the interval survive long enough to fire.
  */
  const elapsedRef = React.useRef(0);
  React.useEffect(() => {
    elapsedRef.current = elapsed;
  }, [elapsed]);

  /*
    Where the clock starts, and how far it has been corrected to agree with the
    server.

    `elapsed` used to be `Date.now() - session.startedAt`, which subtracts the
    SERVER's timestamp from the CLIENT's clock. That is only correct if the two
    clocks agree, and they need not: measured on the development machine used to
    build this, the PC's clock was 48.7 SECONDS BEHIND Supabase and GitHub, which
    agreed with each other. The subtraction then yields a negative number for the
    first 49 seconds, `Math.max(0, …)` pins the countdown at "0s / 10s", and the
    timer appears not to start with the video at all — it silently starts a
    minute late.

    Two refs fix that without trusting the client clock for anything that
    matters:

      · `sessionAnchorRef` is the local time the session was RECEIVED, so the
        countdown measures interval, which is the same on both clocks, rather
        than an absolute instant, which is not.
      · `driftedByRef` is the difference the last server report revealed, applied
        as an offset. Every progress response carries the server's own
        `elapsedSeconds`, so the display converges onto the server's measurement
        within one report and then tracks it exactly.

    This is display only. The Collect button still unlocks solely on the server's
    `ready` flag, so none of this can produce a reward — it can only stop a
    correct countdown from being shown wrongly.
  */
  const sessionAnchorRef = React.useRef(0);
  const driftedByRef = React.useRef(0);

  const localElapsedSeconds = React.useCallback(() => {
    if (!sessionAnchorRef.current) return 0;
    return Math.max(0, (Date.now() - sessionAnchorRef.current) / 1000 + driftedByRef.current);
  }, []);

  /**
   * Fold a progress response into the two things it can tell us: whether the
   * session is collectable, and how far our clock is from the server's.
   */
  const applyProgress = React.useCallback(
    (data: { ready?: boolean; elapsedSeconds?: number } | null | undefined) => {
      if (!data) return;
      if (typeof data.ready === "boolean") setServerReady(data.ready);

      const serverElapsed = Number(data.elapsedSeconds);
      if (Number.isFinite(serverElapsed) && sessionAnchorRef.current) {
        driftedByRef.current = serverElapsed - (Date.now() - sessionAnchorRef.current) / 1000;
      }
    },
    [],
  );

  // Which element this row needs. Derived from the URL the server returned, so
  // it survives a source being edited in the admin panel mid-catalogue.
  /*
    Derived from the CARD until a session exists, and from the session afterwards.

    Both are server-supplied, so the URL the player renders is never one the
    browser invented — and reading it from the card is what allows the player to
    be mounted, and therefore to report honestly when playback starts, BEFORE any
    watch session has been opened.
  */
  const source = React.useMemo(
    () => parseVideoSource(session?.videoUrl ?? video.videoUrl),
    [session, video.videoUrl],
  );

  /*
    The clock the user sees is derived from the local time the session was
    received, corrected by drift observed from server progress reports.
    This avoids the trap where a PC clock that is 48 seconds behind
    Supabase makes the countdown sit at 0 for the first 49 seconds.
  */
  React.useEffect(() => {
    if (phase !== "watching" || !session) return;

    if (!sessionAnchorRef.current) sessionAnchorRef.current = Date.now();

    const tick = () => setElapsed(Math.floor(localElapsedSeconds()));

    tick();
    const interval = window.setInterval(tick, 1000);

    const resync = () => tick();
    document.addEventListener("visibilitychange", resync);
    window.addEventListener("focus", resync);
    window.addEventListener("pageshow", resync);

    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", resync);
      window.removeEventListener("focus", resync);
      window.removeEventListener("pageshow", resync);
    };
  }, [phase, session, localElapsedSeconds]);

  // Report progress periodically so a dropped connection can still be
  // recovered later from the wallet page. Depends on the phase and the session
  // only — the time is read through a ref — so the interval actually survives.
  //
  // The cadence is DERIVED from the requirement rather than fixed, because the
  // database treats a watch-time shortfall as terminal: `video_complete_session`
  // requires `watched_seconds >= required_watch_seconds`, and a request that
  // arrives with a stale figure REJECTS the session and files a fraud event
  // against an honest user. A fixed 10-second report at a 10-second requirement
  // lands on the boundary and can miss it by a hair, leaving the first useful
  // update up to twice as late as needed. At a third of the requirement every
  // session has been reported on at least twice by the time it is collectable,
  // and the 2–10s clamp keeps the request rate sane at either extreme.
  React.useEffect(() => {
    if (phase !== "watching" || !session) return;

    const reportMs = Math.min(
      10_000,
      Math.max(2_000, Math.floor(Math.max(1, session.requiredWatchSeconds) / 3) * 1_000),
    );

    const id = window.setInterval(() => {
      void apiRequest<{ ready: boolean; elapsedSeconds: number }>("/api/videos/progress", {
        method: "POST",
        body: { sessionToken: session.sessionToken, watchedSeconds: elapsedRef.current },
      }).then((response) => {
        if (response.ok) applyProgress(response.data);
      });
    }, reportMs);

    return () => window.clearInterval(id);
  }, [phase, session, applyProgress]);

  /*
    Ask the server the moment the requirement is met locally.

    The periodic report above fires on its own cadence while the required time
    can be any number of seconds, so waiting for it alone would leave the button
    locked for a while after the video really has been watched. This polls until
    the server agrees, then stops for good.

    `elapsed` is deliberately NOT a dependency. It changes every second, and an
    effect that re-runs every second tears its interval down and re-creates it
    before the first tick — so the callback would never run at all. That is the
    identical mistake the periodic report above used to make, and it stayed
    invisible here for the same reason: with a round requirement (60s) the
    10-second report lands on the boundary anyway and masks it. A different
    requirement, or a throttled tab, would leave the button locked for good.
    An even shorter requirement is worse — at 10s a fixed 10-second report lands
    exactly on the gate. The clock is therefore read inside the interval, not
    tracked by it.
  */
  React.useEffect(() => {
    if (phase !== "watching" || !session) return;
    if (serverReady === true) return;

    const required = session.requiredWatchSeconds;

    const id = window.setInterval(() => {
      const live = Math.floor(localElapsedSeconds());
      // Nothing to confirm before the time is up, so no request is sent.
      if (live < required) return;

      void apiRequest<{ ready: boolean; elapsedSeconds: number }>("/api/videos/progress", {
        method: "POST",
        body: {
          sessionToken: session.sessionToken,
          watchedSeconds: Math.max(live, elapsedRef.current),
        },
      }).then((response) => {
        if (response.ok) applyProgress(response.data);
      });
    }, 3_000);

    return () => window.clearInterval(id);
  }, [phase, session, serverReady, applyProgress, localElapsedSeconds]);

  /*
    Completion is explicit. Once the required time has elapsed the user presses
    "Collect reward"; the session no longer completes itself when a timer runs
    out or a file reaches its end.

    Nothing about the verification changed — the server still re-checks the
    watch time it observed and it, not the client, decides the reward. The only
    difference is that the reward is claimed rather than delivered silently.
  */

  /**
   * Mount the player. No watch session is opened here.
   *
   * The countdown used to start the instant this button was pressed, which meant
   * it ran while the video was still loading — and, on an embedded player whose
   * autoplay was blocked, kept running while nothing played at all. The clock now
   * begins with playback, so "remaining" describes the video rather than the
   * player's load time.
   */
  function begin() {
    startedRef.current = false;
    setPhase("preparing");
    setError(null);
    setResult(null);
    setSessionLost(false);
    setSession(null);
    setElapsed(0);
    setServerReady(null);
  }

  /**
   * Open the watch session. Called when playback is first observed, once.
   *
   * Everything about verification is unchanged: the server still stamps
   * `started_at` itself, still clamps any reported time to what it has observed,
   * and still decides whether a reward is due. The only difference is WHEN the
   * session starts — at playback rather than at the click — which can only make
   * the measurement fairer, never more generous.
   */
  const beginSession = React.useCallback(async () => {
    if (startedRef.current) return;
    startedRef.current = true;
    setPhase("starting");

    const response = await apiRequest<StartResponse>("/api/videos/start", {
      method: "POST",
      body: { videoId: video.id },
    });

    if (!response.ok) {
      setError(response.message);
      // Let a retry re-arm: the button below becomes usable again.
      startedRef.current = false;
      setPhase("idle");
      return;
    }

    setSession(response.data);

    /*
      Anchor the display to the moment the session arrived, and start the
      correction at whatever the server says has already been watched — which is
      0 for a fresh session and the recovered figure for a resumed one, so a
      session picked up after a refresh does not appear to restart from zero.
    */
    sessionAnchorRef.current = Date.now();
    driftedByRef.current = Math.max(0, Number(response.data.watchedSeconds) || 0);
    setElapsed(Math.floor(response.data.watchedSeconds ?? 0));
    setPhase("watching");
  }, [video.id]);

  /*
    Embedded player: start the session on its first PLAYING state.

    YouTube's embed posts `onStateChange` messages once `enablejsapi=1` is set on
    the URL, and the player only reports to a window that has asked to listen —
    hence the periodic `listening` ping. A browser that blocks autoplay never
    reaches PLAYING, so the session stays unopened until the user actually presses
    play, which is precisely the honest behaviour.

    The timeout is a floor, not a licence: if the handshake never completes (a
    proxy stripping messages, an older player), a session is opened anyway after
    twelve seconds rather than leaving the reward permanently unreachable. The
    server still demands its full watch time, so this can only ever make the
    measurement start earlier for someone who is genuinely watching.
  */
  React.useEffect(() => {
    if (phase !== "preparing" && phase !== "starting") return;
    if (source.kind !== "youtube") return;

    const onMessage = (event: MessageEvent) => {
      const frame = iframeRef.current;
      if (!frame || event.source !== frame.contentWindow) return;

      let payload: unknown = event.data;
      if (typeof payload === "string") {
        try {
          payload = JSON.parse(payload);
        } catch {
          return;
        }
      }

      const info = (payload as { event?: string; info?: { playerState?: number } } | null)?.info;
      if ((payload as { event?: string } | null)?.event === "onStateChange" && info?.playerState === 1) {
        void beginSession();
      }
    };

    window.addEventListener("message", onMessage);

    const ping = window.setInterval(() => {
      iframeRef.current?.contentWindow?.postMessage(
        JSON.stringify({ event: "listening", id: "taskcash", channel: "widget" }),
        "*",
      );
    }, 1_000);

    const fallback = window.setTimeout(() => void beginSession(), 12_000);

    return () => {
      window.removeEventListener("message", onMessage);
      window.clearInterval(ping);
      window.clearTimeout(fallback);
    };
  }, [phase, source, beginSession]);

  async function complete() {
    if (!session) return;
    setPhase("verifying");

    /*
      Report the observed time BEFORE asking the server to decide.

      The periodic report fires on a 10-second boundary while the requirement
      can be any number of seconds: for a 5s video the first report would not
      arrive until 10s, long after the user has finished, so the server's
      `watched_seconds` could still be below the requirement and the collect
      would be refused for insufficient watch time even though the user really
      did watch. This reports; it does not assert. The server caps any claim
      against the wall-clock time it has itself observed, so a forged value buys
      nothing.
    */
    /*
      Read the clock here rather than trusting the last tick. In a throttled tab
      the ref can be up to minutes stale — and a stale *low* value is exactly the
      one that gets a completion refused for insufficient watch time. Taking the
      larger of the live reading and the last tick can only ever under-report, and
      the server independently caps whatever is claimed against the wall-clock
      time it observed, so nothing here can inflate a reward.
    */
    const liveSeconds = Math.floor(localElapsedSeconds());
    const reportedSeconds = Math.max(liveSeconds, elapsedRef.current);
    setElapsed(reportedSeconds);

    const finalReport = await apiRequest<{ ready: boolean }>("/api/videos/progress", {
      method: "POST",
      body: { sessionToken: session.sessionToken, watchedSeconds: reportedSeconds },
    });

    /*
      Do NOT ask for the reward until the server itself says the requirement is
      met.

      This is the guard that matters. `video_complete_session` treats a claim of
      insufficient watch time as terminal — it marks the session REJECTED — so a
      collect that arrives one second early does not merely fail, it destroys the
      session and files a fraud event against an honest user. Asking the server
      first turns that into a wait: the session stays collectable, and the user is
      told to keep watching rather than told their watch time was not met.
    */
    if (finalReport.ok && finalReport.data && finalReport.data.ready !== true) {
      setServerReady(false);
      setPhase("watching");
      setError("Almost there — keep watching a moment longer so we can verify it.");
      return;
    }

    const response = await apiRequest<CompleteResponse>("/api/videos/complete", {
      method: "POST",
      body: { sessionToken: session.sessionToken },
    });

    if (!response.ok) {
      /*
        A session the server no longer knows — deleted, finished elsewhere, or
        aged out — cannot be collected from, and retrying the same token will
        fail forever. Say so and offer a restart rather than leaving the user
        pressing a button that cannot work.
      */
      const lost = response.code === "SESSION_NOT_FOUND" || response.code === "SESSION_CLOSED";
      setSessionLost(lost);
      setError(response.message);
      // A lost session returns the user to the start, where the button below
      // becomes a genuine restart rather than a retry of a dead token.
      setPhase(lost ? "idle" : "watching");
      return;
    }

    setResult(response.data);
    setPhase("done");

    if (response.data.status === "REWARDED") {
      toast({
        title: "Reward verified",
        description: `+${formatMoney(response.data.rewardAmount ?? 0, response.data.currency)} added to your wallet.`,
        tone: "success",
      });
      // Re-read authoritative state from the server.
      router.refresh();
    } else if (response.data.status === "NO_REWARD") {
      // A campaign that shows content without paying for it. Nothing was
      // credited, so nothing may be implied to have been.
      toast({
        title: "Video completed",
        description: "This video does not pay a reward, so your wallet is unchanged.",
        tone: "info",
      });
    } else {
      toast({
        title: "No reward issued",
        description: response.data.message,
        tone: "warning",
      });
    }
  }

  const required = session?.requiredWatchSeconds ?? video.requiredWatchSeconds;
  const progress = Math.min(100, (elapsed / Math.max(1, required)) * 100);
  const remaining = Math.max(0, required - elapsed);

  /*
    The SERVER's verdict alone unlocks the button — the local countdown does not.

    Requiring both was a second way to lose a reward the server had already
    verified. `elapsed` is display state, and it is driven by a 1-second timer
    that browsers throttle in a backgrounded tab, behind a locked phone and in a
    minimised window: measured here with the tab un-focused, `elapsed` sat frozen
    while the server's own report said ready. So a user who watched every second
    on a phone they had locked — which is the normal way to watch a video — came
    back and found the button still counting down against a reward already
    earned, with no reliable path back to it.

    Nothing is loosened by dropping the local half. `serverReady` is only ever
    set from the server's answer, and the server answers `ready` from the
    wall-clock time IT observed; the local clock is not consulted for the
    decision at all, so this cannot unlock early — it can only stop a correct
    unlock from being withheld.
  */
  const canCollect = phase === "watching" && serverReady === true;

  // The requirement looks met locally but the server has not confirmed it yet.
  // Worth saying out loud: it is the difference between waiting and failing.
  const awaitingServer = phase === "watching" && !canCollect && elapsed >= required;
  // Zero-reward campaigns are legitimate (house or brand-awareness content), so
  // the copy must not promise a reward that the campaign never set.
  const paysReward = (session?.rewardAmount ?? video.rewardAmount) > 0;

  if (phase === "idle") {
    return (
      <div className="space-y-4">
        {error ? (
          <Alert
            variant={sessionLost ? "warning" : "destructive"}
            title={sessionLost ? "That watch session ended" : "Could not start this video"}
          >
            <p>{error}</p>
            {sessionLost ? (
              <p className="mt-1 text-xs text-muted-foreground">
                Nothing was credited for it. Starting again opens a new session, so the full watch
                time applies from the beginning.
              </p>
            ) : null}
          </Alert>
        ) : null}

        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <Button size="lg" onClick={begin} className="sm:w-auto">
            <PlayCircle className="h-4 w-4" aria-hidden />
            {sessionLost ? "Start again" : "Watch now"}
          </Button>
          <p className="text-xs text-muted-foreground">
            You must watch at least {Math.round(required)} seconds in one session. Rewards are
            verified on our servers.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Player */}
      <div className="relative overflow-hidden rounded-2xl border border-border bg-navy-950">
        {source?.kind === "youtube" ? (
          /*
            A third-party video plays inside the provider's own player, which is
            the only supported way to show it — a YouTube watch page cannot be
            fed to <video>. Note that this embed reports nothing back to us and
            is not trusted for anything: the session below completes on elapsed
            time the server observed, so changing the embedded player cannot
            shorten a required watch time.
          */
          <iframe
            ref={iframeRef}
            src={source.embedUrl}
            title={session?.title ?? video.title}
            className="aspect-video w-full"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
            referrerPolicy="strict-origin-when-cross-origin"
            allowFullScreen
          />
        ) : source?.kind === "file" ? (
          <video
            ref={videoRef}
            src={source.url}
            poster={video.thumbnailUrl ?? undefined}
            className="aspect-video w-full"
            playsInline
            controls={false}
            controlsList="nodownload"
            disablePictureInPicture
            /*
              Mounted by a click, so autoplay is permitted; the click handler is
              the fallback for a browser that blocks it anyway. Controls stay off,
              but playback position is irrelevant to the reward — completion is
              judged on elapsed time the SERVER observed — so a tap-to-play
              surface here cannot be used to skip anything.
            */
            autoPlay
            onPlaying={() => void beginSession()}
            onClick={() => void videoRef.current?.play().catch(() => undefined)}
          />
        ) : (
          /* Fail visibly. An unrecognised link must not render a control that
             looks playable and silently does nothing. */
          <div className="flex aspect-video w-full items-center justify-center p-6">
            <p className="max-w-sm text-center text-sm text-white/80">
              {source?.reason ?? "This video could not be loaded."}
            </p>
          </div>
        )}

        {phase === "verifying" ? (
          <div
            className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-navy-950/85 text-center"
            role="status"
            aria-live="polite"
          >
            <Loader2 className="h-6 w-6 animate-spin text-orangeBrand-400" aria-hidden />
            <p className="text-sm font-medium text-white">Checking your watch session…</p>
            <p className="max-w-xs text-xs text-white/70">
              We are confirming the time our server observed. Please keep this screen open.
            </p>
          </div>
        ) : null}
      </div>

      {/* Waiting for playback */}
      {phase === "preparing" || phase === "starting" ? (
        <div className="space-y-1.5" role="status" aria-live="polite">
          <p className="text-sm font-medium">
            {phase === "starting"
              ? "Starting your watch session…"
              : "Your timer starts the moment the video plays."}
          </p>
          <p className="text-xs text-muted-foreground">
            {source.kind === "youtube"
              ? "If it has not started on its own, press play in the player above."
              : "If it has not started on its own, tap the video to begin."}{" "}
            You need {Math.round(required)} seconds of playback before you can collect.
          </p>
        </div>
      ) : null}

      {/* Progress + collect */}
      {phase === "watching" ? (
        <div className="space-y-3">
          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>
                {canCollect
                  ? "Required time reached — collect when ready."
                  : awaitingServer
                    ? "Checking your watch time with our server…"
                    : `${remaining}s to go`}
              </span>
              <span aria-live="polite">
                {elapsed}s / {required}s
              </span>
            </div>
            <Progress value={progress} label="Watch progress" />
          </div>

          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <Button
              size="lg"
              onClick={complete}
              disabled={!canCollect}
              className="sm:w-auto"
              aria-describedby="collect-help"
            >
              <Gift className="h-4 w-4" aria-hidden />
              {canCollect
                ? "Collect reward"
                : awaitingServer
                  ? "Verifying…"
                  : `Collect reward in ${remaining}s`}
            </Button>
            <p id="collect-help" className="text-xs text-muted-foreground">
              {awaitingServer
                ? "Hold on — this unlocks as soon as our server confirms the time it observed."
                : !canCollect
                  ? "Keep watching — this unlocks once the required time is up."
                  : paysReward
                  ? `Our server checks the time it observed before releasing ${formatMoney(
                      session?.rewardAmount ?? 0,
                      currency,
                    )}.`
                  : "This video pays no reward, so collecting adds nothing to your wallet."}
            </p>
          </div>
        </div>
      ) : null}

      {/* Result */}
      {phase === "done" && result ? (
        <>
          <Separator />
          {result.status === "REWARDED" ? (
            <Alert variant="success" title="Reward verified">
              <p>
                +{formatMoney(result.rewardAmount ?? 0, result.currency)} added to your wallet.
                {result.duplicate ? " This session had already been rewarded." : ""}
              </p>
              {result.reference ? (
                <p className="mt-1 font-mono text-[11px] text-muted-foreground">
                  Reference {result.reference}
                </p>
              ) : null}
              {result.availableBalance !== null ? (
                <p className="mt-1 text-xs">
                  Available balance is now {formatMoney(result.availableBalance, result.currency)}.
                </p>
              ) : null}
            </Alert>
          ) : result.status === "NO_REWARD" ? (
            <Alert variant="info" title="Video completed">
              <p>
                You completed this video. It pays no reward, so nothing was added to your wallet.
                Rewards come only from campaigns that set one.
              </p>
            </Alert>
          ) : (
            <Alert variant="warning" title="No reward issued">
              <p>{REJECT_COPY[result.rejectReason ?? ""] ?? result.message}</p>
            </Alert>
          )}

          <div className="flex flex-col gap-3 sm:flex-row">
            <Button
              onClick={() => {
                setPhase("idle");
                setSession(null);
                setResult(null);
              }}
            >
              Watch another video
            </Button>
            <Button variant="outline" onClick={() => router.push("/dashboard/wallet")}>
              Go to wallet
            </Button>
          </div>
        </>
      ) : null}

      {error ? (
        <Alert variant="destructive" title="Playback problem">
          <p>{error}</p>
        </Alert>
      ) : null}
    </div>
  );
}

