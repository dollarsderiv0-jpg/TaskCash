"use client";

import * as React from "react";
import { CheckCircle2, Lock, Play } from "lucide-react";
import { cn, formatMoney, formatSecondsRemaining } from "@/lib/format";
import type { Task } from "@/lib/types";
import { PrimaryButton } from "./primary-button";
import { StatusBadge } from "./status-badge";

type Phase = "idle" | "watching" | "ready" | "claimed" | "locked";

/**
 * A single watch task.
 *
 * The countdown is mock, but the gating is real within the prototype: the claim
 * button stays disabled until the watch time has actually elapsed, and a task
 * that has already been paid cannot be paid again.
 */
export function TaskCard({
  task,
  claimed,
  locked = false,
  lockReason,
  onClaim,
}: {
  task: Task;
  claimed: boolean;
  /** True when the tier is inactive or today's quota is used up. */
  locked?: boolean;
  lockReason?: string;
  onClaim: (task: Task) => void;
}) {
  const [remaining, setRemaining] = React.useState(task.durationSeconds);
  const [watching, setWatching] = React.useState(false);

  const elapsed = task.durationSeconds - remaining;
  const progress = Math.min(100, Math.round((elapsed / task.durationSeconds) * 100));

  React.useEffect(() => {
    if (!watching) return;
    const timer = window.setInterval(() => {
      setRemaining((prev) => {
        if (prev <= 1) {
          window.clearInterval(timer);
          setWatching(false);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [watching]);

  const phase: Phase = claimed
    ? "claimed"
    : locked
      ? "locked"
      : remaining <= 0
        ? "ready"
        : watching
          ? "watching"
          : "idle";

  return (
    <article className="tc-card p-3.5 sm:p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-[15px] font-bold tracking-tight text-white">{task.title}</h3>
          <p className="mt-0.5 truncate text-xs text-muted">{task.videoLabel}</p>
        </div>
        <StatusBadge
          tone={phase === "claimed" ? "active" : phase === "locked" ? "inactive" : "pending"}
        >
          {phase === "claimed" ? "Claimed" : phase === "locked" ? "Locked" : "Available"}
        </StatusBadge>
      </div>

      <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-center">
        {/* Video placeholder — the play button is the only control. */}
        <button
          type="button"
          onClick={() => {
            if (phase === "idle") {
              setWatching(true);
              setRemaining(task.durationSeconds);
            }
          }}
          disabled={phase !== "idle"}
          aria-label={phase === "idle" ? `Play ${task.title}` : `${task.title} in progress`}
          className={cn(
            "group relative grid h-32 w-full shrink-0 place-items-center overflow-hidden rounded-tile border border-hairline bg-black sm:h-24 sm:w-40",
            phase === "idle" && "cursor-pointer hover:border-flame/50",
          )}
        >
          <span
            aria-hidden
            className="absolute inset-0 bg-[radial-gradient(circle_at_50%_60%,rgba(244,81,11,.16),transparent_65%)]"
          />
          {phase === "idle" ? (
            <span className="relative grid h-11 w-11 place-items-center rounded-full bg-gradient-to-b from-flame-400 to-flame shadow-flame transition group-hover:scale-105">
              <Play className="ml-0.5 h-5 w-5 fill-white text-white" aria-hidden />
            </span>
          ) : phase === "watching" ? (
            <span className="tnum relative text-lg font-bold text-white">
              {formatSecondsRemaining(remaining)}
            </span>
          ) : phase === "claimed" ? (
            <CheckCircle2 className="relative h-7 w-7 text-cash" aria-hidden />
          ) : (
            <Lock className="relative h-6 w-6 text-muted" aria-hidden />
          )}
        </button>

        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <span className="tc-label">Reward</span>
            <span className="tnum text-[15px] font-bold text-cash">
              {formatMoney(task.reward)}
            </span>
          </div>

          <div
            className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-base"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progress}
            aria-label={`${task.title} watch progress`}
          >
            <div
              className="h-full rounded-full bg-gradient-to-r from-flame to-flame-400 transition-[width] duration-1000 ease-linear"
              style={{ width: `${progress}%` }}
            />
          </div>

          <p className="mt-1.5 text-[11px] text-muted">
            {phase === "idle" && "Tap play to start the timed task."}
            {phase === "watching" && formatSecondsRemaining(remaining)}
            {phase === "ready" && "Watch time complete — reward ready to claim."}
            {phase === "claimed" && "Reward already credited to your wallet."}
            {phase === "locked" && (lockReason ?? "Unavailable right now.")}
          </p>

          <div className="mt-3">
            <PrimaryButton
              full
              size="sm"
              variant={phase === "ready" ? "flame" : "ghost"}
              disabled={phase !== "ready"}
              onClick={() => {
                onClaim(task);
                setWatching(false);
              }}
            >
              {phase === "claimed" ? "Claimed" : "Claim Reward"}
            </PrimaryButton>
          </div>
        </div>
      </div>
    </article>
  );
}
