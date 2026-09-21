"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/fields";
import { Alert } from "@/components/ui/misc";
import { PLATFORM_NOT_CONFIGURED_MESSAGE, isSupabaseConfigured } from "@/lib/env";

/**
 * The two actions an unverified user actually needs: send it again, or fix the
 * address. A wall with no way forward is how support tickets are made.
 *
 * Both calls return the same neutral message whether or not anything was sent,
 * so this component never claims an email was delivered — it says it was
 * *requested*, which is all the server can honestly confirm.
 */
/**
 * How long the button stays disabled after a successful request. Only a
 * default: when the server refuses with its own `retryAfterSeconds`, that value
 * wins, because it is measured and this is not.
 */
const RESEND_COOLDOWN_SECONDS = 60;

/** A refused request, carrying the server's stated wait when it supplies one. */
class ApiFailure extends Error {
  constructor(
    message: string,
    readonly retryAfterSeconds: number | null,
  ) {
    super(message);
    this.name = "ApiFailure";
  }
}

export function VerifyEmailActions({ email }: { email: string | null }) {
  const [resending, setResending] = React.useState(false);
  const [resendMessage, setResendMessage] = React.useState<string | null>(null);
  const [resendError, setResendError] = React.useState<string | null>(null);
  const [cooldown, setCooldown] = React.useState(0);

  // A visible countdown, rather than a button that silently does nothing or a
  // raw 429. The server keeps its own limit; this is so the user is not left
  // guessing how long "too many attempts, wait a moment" actually is.
  React.useEffect(() => {
    if (cooldown <= 0) return;
    const timer = window.setInterval(() => setCooldown((value) => (value <= 1 ? 0 : value - 1)), 1000);
    return () => window.clearInterval(timer);
  }, [cooldown]);

  const [showChange, setShowChange] = React.useState(false);
  const [newEmail, setNewEmail] = React.useState("");
  const [changing, setChanging] = React.useState(false);
  const [changeMessage, setChangeMessage] = React.useState<string | null>(null);
  const [changeError, setChangeError] = React.useState<string | null>(null);

  async function post(path: string, body?: unknown, setError?: (m: string) => void) {
    const response = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await response.json().catch(() => null);
    if (!response.ok || json?.ok === false) {
      const message = json?.error?.message ?? json?.message ?? "Something went wrong. Please try again.";
      if (setError) setError(message);

      const stated =
        json?.retryAfterSeconds ?? json?.error?.details?.retryAfterSeconds ?? null;
      throw new ApiFailure(
        message,
        typeof stated === "number" && stated > 0 ? stated : null,
      );
    }
    return json?.data ?? json;
  }

  async function onResend() {
    if (!isSupabaseConfigured()) {
      setResendError(PLATFORM_NOT_CONFIGURED_MESSAGE);
      return;
    }
    setResending(true);
    setResendError(null);
    setResendMessage(null);
    try {
      const data = await post("/api/auth/resend-verification", undefined, setResendError);
      setResendMessage(data?.message ?? "A new confirmation email has been requested.");
      setCooldown(RESEND_COOLDOWN_SECONDS);
    } catch (error) {
      // The server's own limit is authoritative, so wait even when it refuses —
      // otherwise the button invites a retry it will immediately reject. Prefer
      // the wait the server stated: this bucket allows three an hour, so a flat
      // 60-second cooldown would re-enable the button into another refusal.
      const stated = error instanceof ApiFailure ? error.retryAfterSeconds : null;
      setCooldown(stated && stated > RESEND_COOLDOWN_SECONDS ? stated : RESEND_COOLDOWN_SECONDS);
    } finally {
      setResending(false);
    }
  }

  async function onChangeEmail(event: React.FormEvent) {
    event.preventDefault();
    if (!isSupabaseConfigured()) {
      setChangeError(PLATFORM_NOT_CONFIGURED_MESSAGE);
      return;
    }
    setChanging(true);
    setChangeError(null);
    setChangeMessage(null);
    try {
      const data = await post("/api/auth/change-email", { email: newEmail }, setChangeError);
      setChangeMessage(data?.message ?? "Check the new address for a confirmation link.");
      setShowChange(false);
    } catch {
      /* message already surfaced */
    } finally {
      setChanging(false);
    }
  }

  return (
    <div className="space-y-4">
      <Button
        onClick={onResend}
        disabled={resending || cooldown > 0}
        className="w-full min-h-11"
        aria-live="polite"
      >
        {resending
          ? "Requesting…"
          : cooldown > 0
            ? `RESEND AVAILABLE IN ${cooldown}s`
            : "RESEND EMAIL"}
      </Button>

      {resendMessage ? <Alert variant="success">{resendMessage}</Alert> : null}
      {resendError ? <Alert variant="destructive">{resendError}</Alert> : null}

      {showChange ? (
        <form onSubmit={onChangeEmail} className="space-y-3">
          <Field label="New email address" htmlFor="new-email">
            <Input
              id="new-email"
              type="email"
              autoComplete="email"
              value={newEmail}
              onChange={(event) => setNewEmail(event.target.value)}
              placeholder="you@example.com"
              required
            />
          </Field>
          <div className="flex gap-2">
            <Button type="submit" variant="outline" disabled={changing} className="flex-1">
              {changing ? "Saving…" : "Confirm change"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setShowChange(false)}
              className="flex-1"
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <Button variant="outline" onClick={() => setShowChange(true)} className="w-full">
          CHANGE EMAIL
        </Button>
      )}

      {changeMessage ? <Alert variant="success">{changeMessage}</Alert> : null}
      {changeError ? <Alert variant="destructive">{changeError}</Alert> : null}

      {email ? (
        <p className="text-xs text-muted-foreground">
          Currently waiting on confirmation for <span className="font-medium">{email}</span>.
        </p>
      ) : null}
    </div>
  );
}
