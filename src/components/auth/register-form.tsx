"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Eye, EyeOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox, Field, Input, Select } from "@/components/ui/fields";
import { Alert } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { COUNTRIES, currencyForCountry, normalisePhone } from "@/lib/countries";
import { formatCountdown } from "@/lib/duration";
import { PLATFORM_NOT_CONFIGURED_MESSAGE, isSupabaseConfigured } from "@/lib/env";

type Errors = Record<string, string>;

export function RegisterForm() {
  const router = useRouter();
  const params = useSearchParams();
  const { toast } = useToast();

  const [form, setForm] = React.useState({
    fullName: "",
    email: "",
    phone: "",
    password: "",
    country: "KE",
    currency: "KES",
    referralCode: params.get("ref")?.toUpperCase() ?? "",
    acceptTerms: false,
  });
  const [showPassword, setShowPassword] = React.useState(false);
  const [errors, setErrors] = React.useState<Errors>({});
  const [formError, setFormError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  /**
   * Seconds until the server will accept another attempt. Held as a real
   * countdown because the registration window is an hour long: telling someone
   * to "try again shortly" when the true wait is 40 minutes leaves them
   * retrying blindly, and every retry pushes the counter further out.
   */
  const [retryAfter, setRetryAfter] = React.useState<number | null>(null);

  React.useEffect(() => {
    if (retryAfter === null || retryAfter <= 0) return;
    const timer = window.setInterval(() => {
      setRetryAfter((current) => (current === null ? null : Math.max(0, current - 1)));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [retryAfter]);

  // The window has rolled over. Clear the block and the message with it, so the
  // form re-enables itself instead of waiting for a reload.
  React.useEffect(() => {
    if (retryAfter !== 0) return;
    setRetryAfter(null);
    setFormError(null);
  }, [retryAfter]);

  const blocked = (retryAfter ?? 0) > 0;

  /**
   * Client-side checks are a courtesy only — the API re-validates everything
   * with the same rules and the database is the final authority.
   */
  function validate(): Errors {
    const next: Errors = {};

    if (form.fullName.trim().length < 2) next.fullName = "Enter your full name.";

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(form.email.trim())) {
      next.email = "Enter a valid email address.";
    }

    const phone = normalisePhone(form.phone, form.country);
    if (!phone.ok) next.phone = phone.reason;

    if (form.password.length < 10) next.password = "Use at least 10 characters.";
    else if (!/[a-z]/.test(form.password)) next.password = "Include a lowercase letter.";
    else if (!/[A-Z]/.test(form.password)) next.password = "Include an uppercase letter.";
    else if (!/[0-9]/.test(form.password)) next.password = "Include a number.";

    if (!form.acceptTerms) next.acceptTerms = "You must accept the Terms and Privacy Policy.";

    return next;
  }

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    const validation = validate();
    setErrors(validation);
    setFormError(null);

    if (Object.keys(validation).length > 0) return;

    // Submitting would fail server-side anyway; say why without a round trip.
    if (!isSupabaseConfigured()) {
      setFormError(PLATFORM_NOT_CONFIGURED_MESSAGE);
      return;
    }

    setLoading(true);

    try {
      const response = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fullName: form.fullName.trim(),
          email: form.email.trim(),
          phone: form.phone.trim(),
          password: form.password,
          country: form.country,
          currency: form.currency,
          referralCode: form.referralCode.trim() || undefined,
          acceptTerms: form.acceptTerms,
        }),
      });

      if (!response.ok) {
        // A field-level error from the server replaces the client's view of it.
        try {
          const body = (await response.json()) as {
            retryAfterSeconds?: number;
            error?: {
              message?: string;
              details?: { fields?: Errors; retryAfterSeconds?: number };
            };
          };
          setErrors(body.error?.details?.fields ?? {});
          setFormError(body.error?.message ?? "We could not create your account.");

          // Prefer the top-level field; fall back to the nested one so a client
          // built against the other shape still gets the countdown. The header
          // is the last resort, and is only meaningful for 429/503.
          const retrySeconds =
            body.retryAfterSeconds ?? body.error?.details?.retryAfterSeconds;
          if (response.status === 429) {
            const fromHeader = Number(response.headers.get("Retry-After"));
            const seconds =
              typeof retrySeconds === "number" && retrySeconds > 0
                ? retrySeconds
                : Number.isFinite(fromHeader) && fromHeader > 0
                  ? fromHeader
                  : null;
            if (seconds !== null) setRetryAfter(Math.ceil(seconds));
          }
        } catch {
          setFormError("We could not create your account. Please try again.");
        }
        return;
      }

      const body = (await response.json()) as {
        data?: {
          requiresEmailConfirmation?: boolean;
          sessionEstablished?: boolean;
          message?: string;
        };
      };

      /*
        The account exists but the session did not take. Sending them to
        /dashboard would bounce them straight back to sign-in with no
        explanation, and resubmitting this form would fail on a duplicate
        address — so it says what to do instead.
      */
      if (body.data?.sessionEstablished === false) {
        toast({
          title: "Account created",
          description: body.data.message ?? "Please sign in to continue.",
          tone: "success",
        });
        router.push("/login");
        return;
      }

      /*
        Kept for the documented revert path: if registration goes back to
        verified sign-ups, the API returns this again and the form must send the
        user to their inbox rather than to a dashboard they cannot use yet.
      */
      if (body.data?.requiresEmailConfirmation) {
        toast({
          title: "Check your inbox",
          description: body.data.message ?? "Confirm your email address, then sign in.",
          tone: "success",
        });
        router.push("/login");
        return;
      }

      toast({
        title: "Welcome to TaskCash Pro",
        description: body.data?.message ?? "Your account is ready.",
        tone: "success",
      });
      router.push("/dashboard");
      router.refresh();
    } catch {
      setFormError("We could not reach the server. Check your connection and try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-5" noValidate>
      {formError ? (
        <Alert variant="destructive" title="Registration failed">
          <p>{formError}</p>
          {blocked ? (
            <p className="mt-2 text-sm">
              You can try again in{" "}
              <span className="font-semibold tabular-nums" aria-live="polite">
                {formatCountdown(retryAfter ?? 0)}
              </span>
              . This limit protects TaskCash accounts from automated sign-ups.
            </p>
          ) : null}
        </Alert>
      ) : null}

      <Field label="Full name" htmlFor="fullName" error={errors.fullName}>
        <Input
          id="fullName"
          autoComplete="name"
          required
          value={form.fullName}
          onChange={(e) => setForm({ ...form, fullName: e.target.value })}
          aria-invalid={Boolean(errors.fullName)}
          placeholder="As it appears on your ID"
        />
      </Field>

      <Field label="Email address" htmlFor="email" error={errors.email}>
        <Input
          id="email"
          type="email"
          autoComplete="email"
          inputMode="email"
          required
          value={form.email}
          onChange={(e) => setForm({ ...form, email: e.target.value })}
          aria-invalid={Boolean(errors.email)}
          placeholder="you@example.com"
        />
      </Field>

      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="Country" htmlFor="country">
          <Select
            id="country"
            value={form.country}
            onChange={(e) => {
              const country = e.target.value;
              setForm({ ...form, country, currency: currencyForCountry(country) });
            }}
          >
            {COUNTRIES.map((country) => (
              <option key={country.code} value={country.code}>
                {country.name}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="Currency" htmlFor="currency" hint="Set from your country. More currencies can be enabled later.">
          <Input id="currency" value={form.currency} readOnly aria-readonly />
        </Field>
      </div>

      <Field
        label="Mobile money number"
        htmlFor="phone"
        error={errors.phone}
        hint="Used for deposits and for withdrawal payouts. Use the number registered in your own name."
      >
        <Input
          id="phone"
          type="tel"
          autoComplete="tel"
          inputMode="tel"
          required
          value={form.phone}
          onChange={(e) => setForm({ ...form, phone: e.target.value })}
          aria-invalid={Boolean(errors.phone)}
          placeholder={form.country === "KE" ? "0712 345 678" : "Your mobile number"}
        />
      </Field>

      <Field
        label="Password"
        htmlFor="password"
        error={errors.password}
        hint="At least 10 characters with an uppercase letter, a lowercase letter and a number."
      >
        <div className="relative">
          <Input
            id="password"
            type={showPassword ? "text" : "password"}
            autoComplete="new-password"
            required
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
            aria-invalid={Boolean(errors.password)}
            className="pr-11"
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

      <Field label="Referral code (optional)" htmlFor="referralCode" hint="If someone invited you, their code is applied to your account.">
        <Input
          id="referralCode"
          value={form.referralCode}
          onChange={(e) => setForm({ ...form, referralCode: e.target.value.toUpperCase() })}
          placeholder="TCXXXXX"
        />
      </Field>

      <div className="space-y-2">
        <label className="flex items-start gap-3 text-sm">
          <Checkbox
            checked={form.acceptTerms}
            onCheckedChange={(checked) => setForm({ ...form, acceptTerms: checked === true })}
            aria-invalid={Boolean(errors.acceptTerms)}
            className="mt-0.5"
          />
          <span className="leading-relaxed text-muted-foreground">
            I have read and accept the{" "}
            <Link className="font-medium text-primary hover:underline" href="/terms">
              Terms of Service
            </Link>
            ,{" "}
            <Link className="font-medium text-primary hover:underline" href="/privacy">
              Privacy Policy
            </Link>{" "}
            and{" "}
            <Link className="font-medium text-primary hover:underline" href="/rewards-policy">
              Rewards Policy
            </Link>
            .
          </span>
        </label>
        {errors.acceptTerms ? (
          <p className="text-xs font-medium text-destructive" role="alert">
            {errors.acceptTerms}
          </p>
        ) : null}
      </div>

      <Button type="submit" className="w-full" size="sm" loading={loading} disabled={blocked}>
        {blocked ? `Try again in ${formatCountdown(retryAfter ?? 0)}` : "Create account"}
      </Button>

      <p className="text-center text-xs text-muted-foreground">
        Already have an account?{" "}
        <Link href="/login" className="font-semibold text-primary hover:underline">
          Sign in
        </Link>
      </p>
    </form>
  );
}
