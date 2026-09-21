"use client";

import * as React from "react";
import Link from "next/link";
import { Check, ChevronRight, PartyPopper, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/misc";
import { cn } from "@/lib/utils";

/**
 * First-time checklist.
 *
 * Every step is derived from data the account has actually produced — profile
 * fields that were filled in, a session that was watched, a reward that was
 * credited. Nothing here is a self-reported checkbox, so a step can never say
 * "done" when the underlying thing never happened.
 *
 * Dismissing is remembered in localStorage: it is purely a presentation
 * preference, so it does not belong in the database, and it must not be
 * mistaken for real progress.
 */

export type OnboardingStep = {
  key: string;
  title: string;
  description: string;
  href: string;
  action: string;
  done: boolean;
  optional?: boolean;
};

const DISMISS_KEY = "taskcash.onboarding.dismissed";

export function OnboardingChecklist({ steps }: { steps: OnboardingStep[] }) {
  const [dismissed, setDismissed] = React.useState(false);
  const [ready, setReady] = React.useState(false);

  // Read after mount so the server and the first client render agree.
  React.useEffect(() => {
    try {
      setDismissed(window.localStorage.getItem(DISMISS_KEY) === "1");
    } catch {
      // Private mode / storage disabled — the checklist simply stays visible.
    }
    setReady(true);
  }, []);

  const doneCount = steps.filter((step) => step.done).length;
  const allDone = doneCount === steps.length;

  // Once everything is complete the checklist has said its piece.
  if (allDone || (ready && dismissed)) return null;

  const nextStep = steps.find((step) => !step.done);

  function dismiss() {
    try {
      window.localStorage.setItem(DISMISS_KEY, "1");
    } catch {
      // Ignore — hiding it for this page view is still the right behaviour.
    }
    setDismissed(true);
  }

  return (
    <div className="rounded-2xl border border-border bg-card p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-bold tracking-tight">
            <PartyPopper className="h-5 w-5 text-primary" aria-hidden />
            Welcome to TaskCash Pro
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {allDone
              ? "You have finished every step. Nice work."
              : `Getting started is quick — ${doneCount} of ${steps.length} done.`}
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={dismiss}
          className="shrink-0 text-muted-foreground"
          aria-label="Skip the getting started checklist"
        >
          <X className="h-4 w-4" aria-hidden />
          Skip
        </Button>
      </div>

      <Progress
        className="mt-4"
        value={(doneCount / steps.length) * 100}
        label={`Getting started progress: ${doneCount} of ${steps.length}`}
      />

      <ol className="mt-5 space-y-2">
        {steps.map((step) => {
          const isNext = !step.done && step.key === nextStep?.key;
          return (
            <li key={step.key}>
              <Link
                href={step.href}
                className={cn(
                  "flex items-center gap-3 rounded-xl border p-3 transition-colors",
                  step.done
                    ? "border-transparent bg-muted/30"
                    : isNext
                      ? "border-primary/40 bg-primary/5 hover:bg-primary/10"
                      : "border-border hover:bg-secondary/50",
                )}
              >
                <span
                  className={cn(
                    "flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-xs font-semibold",
                    step.done
                      ? "border-emeraldBrand-500 bg-emeraldBrand-500 text-white"
                      : "border-border text-muted-foreground",
                  )}
                  aria-hidden
                >
                  {step.done ? <Check className="h-4 w-4" /> : null}
                </span>

                <span className="min-w-0 flex-1">
                  <span
                    className={cn(
                      "block text-sm font-semibold",
                      step.done && "text-muted-foreground line-through",
                    )}
                  >
                    {step.title}
                    {step.optional ? (
                      <span className="ml-2 text-[11px] font-normal uppercase tracking-wide text-muted-foreground">
                        optional
                      </span>
                    ) : null}
                  </span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    {step.description}
                  </span>
                </span>

                {step.done ? (
                  <span className="shrink-0 text-xs font-medium text-muted-foreground">Done</span>
                ) : (
                  <span className="flex shrink-0 items-center gap-1 text-xs font-semibold text-primary">
                    {step.action}
                    <ChevronRight className="h-3.5 w-3.5" aria-hidden />
                  </span>
                )}
              </Link>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
