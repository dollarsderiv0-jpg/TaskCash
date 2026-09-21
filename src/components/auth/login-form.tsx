"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Eye, EyeOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/fields";
import { Alert } from "@/components/ui/misc";
import { useToast, readApiError } from "@/components/ui/toast";
import { PLATFORM_NOT_CONFIGURED_MESSAGE, isSupabaseConfigured } from "@/lib/env";

export function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const { toast } = useToast();

  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [showPassword, setShowPassword] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const nextPath = params.get("next");
  const justRegistered = params.get("registered") === "1";
  const justReset = params.get("reset") === "1";

  /*
    The confirmation callback redirects here with one of these when it cannot
    hand the user a session. Both used to arrive and be ignored, so a user whose
    link failed saw a bare sign-in form with no idea what had happened. The
    account is usually verified anyway in the `failed` case (the provider
    confirms the address, then the code exchange needs the browser that started
    the sign-up), so the wording must not tell them their account is broken.
  */
  const confirmOutcome = params.get("confirm");

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();

    // Submitting would fail server-side anyway; say why without a round trip.
    if (!isSupabaseConfigured()) {
      setError(PLATFORM_NOT_CONFIGURED_MESSAGE);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });

      if (!response.ok) {
        setError(await readApiError(response));
        return;
      }

      const body = (await response.json()) as { data?: { role?: string } };
      toast({ title: "Welcome back", tone: "success" });

      const role = body.data?.role;
      const destination =
        nextPath && nextPath.startsWith("/")
          ? nextPath
          : role === "ADMIN" || role === "SUPER_ADMIN"
            ? "/admin"
            : "/dashboard";

      router.push(destination);
      router.refresh();
    } catch {
      setError("We could not reach the server. Check your connection and try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-5" noValidate>
      {justRegistered ? (
        <Alert variant="success" title="Account created">
          <p>Sign in with your email address and password to continue.</p>
        </Alert>
      ) : null}

      {justReset ? (
        <Alert variant="success" title="Password updated">
          <p>Sign in with your new password.</p>
        </Alert>
      ) : null}

      {confirmOutcome === "failed" ? (
        <Alert variant="destructive" title="We couldn't finish confirming that link">
          <p>
            It may have expired, or it may have been opened in a different browser to the one you
            signed up in. If you have already confirmed your email address, just sign in below —
            otherwise sign in and we will offer to send you a new link.
          </p>
        </Alert>
      ) : null}

      {confirmOutcome === "missing" ? (
        <Alert variant="warning" title="That confirmation link was incomplete">
          <p>
            Please open the most recent email we sent you and use the whole link. If it still does
            not work, sign in and we will offer to send you a new one.
          </p>
        </Alert>
      ) : null}

      {error ? <Alert variant="destructive" title="Could not sign you in"><p>{error}</p></Alert> : null}

      <Field label="Email address" htmlFor="email">
        <Input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          inputMode="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
        />
      </Field>

      <Field label="Password" htmlFor="password">
        <div className="relative">
          <Input
            id="password"
            name="password"
            type={showPassword ? "text" : "password"}
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="pr-11"
            placeholder="Your password"
          />
          <button
            type="button"
            onClick={() => setShowPassword((v) => !v)}
            className="absolute right-1.5 top-1.5 inline-flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-secondary"
            aria-label={showPassword ? "Hide password" : "Show password"}
          >
            {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
        </div>
      </Field>

      <div className="flex items-center justify-between">
        <Link href="/forgot-password" className="text-sm font-medium text-primary hover:underline">
          Forgot your password?
        </Link>
      </div>

      <Button type="submit" className="w-full" size="lg" loading={loading}>
        Sign in
      </Button>

      <p className="text-center text-sm text-muted-foreground">
        New to TaskCash Pro?{" "}
        <Link href="/register" className="font-semibold text-primary hover:underline">
          Create an account
        </Link>
      </p>
    </form>
  );
}
