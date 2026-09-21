"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/fields";
import { Alert } from "@/components/ui/misc";
import { useToast, readApiError } from "@/components/ui/toast";
import { PLATFORM_NOT_CONFIGURED_MESSAGE, isSupabaseConfigured } from "@/lib/env";

export function ForgotPasswordForm() {
  const [email, setEmail] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const [sent, setSent] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

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
      const response = await fetch("/api/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });

      if (!response.ok) {
        setError(await readApiError(response));
        return;
      }

      const body = (await response.json()) as { data?: { message?: string } };
      setSent(body.data?.message ?? "Check your inbox for the reset link.");
    } catch {
      setError("We could not reach the server. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  if (sent) {
    return (
      <div className="space-y-5">
        <Alert variant="success" title="Check your inbox">
          <p>{sent}</p>
        </Alert>
        <Button asChild variant="outline" className="w-full">
          <Link href="/login">Back to sign in</Link>
        </Button>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-5" noValidate>
      {error ? <Alert variant="destructive" title="Could not send the link"><p>{error}</p></Alert> : null}

      <Field
        label="Email address"
        htmlFor="email"
        hint="We will send a reset link if an account exists for that address."
      >
        <Input
          id="email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
        />
      </Field>

      <Button type="submit" className="w-full" size="lg" loading={loading}>
        Send reset link
      </Button>

      <p className="text-center text-sm text-muted-foreground">
        <Link href="/login" className="font-semibold text-primary hover:underline">
          Back to sign in
        </Link>
      </p>
    </form>
  );
}

export function ResetPasswordForm() {
  const router = useRouter();
  const { toast } = useToast();

  const [password, setPassword] = React.useState("");
  const [confirmPassword, setConfirmPassword] = React.useState("");
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [formError, setFormError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    const next: Record<string, string> = {};

    if (password.length < 10) next.password = "Use at least 10 characters.";
    else if (!/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/[0-9]/.test(password)) {
      next.password = "Include an uppercase letter, a lowercase letter and a number.";
    }
    if (password !== confirmPassword) next.confirmPassword = "Passwords do not match.";

    setErrors(next);
    setFormError(null);
    if (Object.keys(next).length > 0) return;

    // Submitting would fail server-side anyway; say why without a round trip.
    if (!isSupabaseConfigured()) {
      setFormError(PLATFORM_NOT_CONFIGURED_MESSAGE);
      return;
    }

    setLoading(true);

    try {
      const response = await fetch("/api/auth/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password, confirmPassword }),
      });

      if (!response.ok) {
        setFormError(await readApiError(response));
        return;
      }

      toast({ title: "Password updated", tone: "success" });
      router.push("/login?reset=1");
      router.refresh();
    } catch {
      setFormError("We could not reach the server. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-5" noValidate>
      {formError ? <Alert variant="destructive" title="Could not update your password"><p>{formError}</p></Alert> : null}

      <Field
        label="New password"
        htmlFor="password"
        error={errors.password}
        hint="At least 10 characters with an uppercase letter, a lowercase letter and a number."
      >
        <Input
          id="password"
          type="password"
          autoComplete="new-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </Field>

      <Field label="Confirm new password" htmlFor="confirmPassword" error={errors.confirmPassword}>
        <Input
          id="confirmPassword"
          type="password"
          autoComplete="new-password"
          required
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
        />
      </Field>

      <Button type="submit" className="w-full" size="lg" loading={loading}>
        Update password
      </Button>
    </form>
  );
}
