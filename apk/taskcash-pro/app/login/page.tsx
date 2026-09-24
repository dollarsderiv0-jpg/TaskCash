"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Eye, EyeOff, Lock, Mail, ShieldCheck } from "lucide-react";
import { PrimaryButton } from "@/components/primary-button";
import { Brand } from "@/components/brand";
import { useToast } from "@/components/toast";
import { DEMO_CREDENTIALS } from "@/lib/mock-data";
import { useStore } from "@/lib/store";

export default function LoginPage() {
  const router = useRouter();
  const toast = useToast();
  const { login, ready, authed } = useStore();

  /* Explicit type arguments: DEMO_CREDENTIALS is `as const`, so inference would
     otherwise pin these to the literal string types. */
  const [email, setEmail] = React.useState<string>(DEMO_CREDENTIALS.email);
  const [password, setPassword] = React.useState<string>(DEMO_CREDENTIALS.password);
  const [reveal, setReveal] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  /* Already signed in? Skip the form rather than showing it again. */
  React.useEffect(() => {
    if (ready && authed) router.replace("/dashboard");
  }, [ready, authed, router]);

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    window.setTimeout(() => {
      const result = login(email, password);
      if (!result.ok) {
        setError(result.message ?? "Unable to sign in.");
        setBusy(false);
        return;
      }
      toast.success("Signed in", "Welcome back to TaskCash Pro.");
      router.push("/dashboard");
    }, 420);
  };

  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-10">
      <div className="w-full max-w-[420px]">
        <div className="mb-5 text-center">
          <Brand href="/login" className="text-[17px] tracking-[0.18em]" />
          <p className="mt-2 text-[11px] font-semibold uppercase tracking-[0.24em] text-muted">
            Rewards Platform
          </p>
        </div>

        <div className="tc-card animate-fade-up p-5 sm:p-6">
          <h1 className="text-xl font-extrabold tracking-tight text-white">Welcome Back</h1>
          <p className="mt-1 text-[13px] leading-snug text-muted">
            Sign in to access your wallet and tasks.
          </p>

          <form onSubmit={handleSubmit} className="mt-4 space-y-3.5">
            <div>
              <label htmlFor="email" className="mb-1.5 block text-[13px] font-semibold text-white">
                Email Address
              </label>
              <div className="relative">
                <Mail
                  className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted"
                  aria-hidden
                />
                <input
                  id="email"
                  name="email"
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="you@example.com"
                  className="h-11 w-full rounded-tile border border-hairline bg-base/70 pl-9 pr-3 text-sm text-white placeholder:text-muted/70 focus:border-flame/60 focus:outline-none focus:ring-2 focus:ring-flame/25"
                />
              </div>
            </div>

            <div>
              <label htmlFor="password" className="mb-1.5 block text-[13px] font-semibold text-white">
                Password
              </label>
              <div className="relative">
                <Lock
                  className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted"
                  aria-hidden
                />
                <input
                  id="password"
                  name="password"
                  type={reveal ? "text" : "password"}
                  autoComplete="current-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder="••••••••••••"
                  className="h-11 w-full rounded-tile border border-hairline bg-base/70 pl-9 pr-11 text-sm text-white placeholder:text-muted/70 focus:border-flame/60 focus:outline-none focus:ring-2 focus:ring-flame/25"
                />
                <button
                  type="button"
                  onClick={() => setReveal((prev) => !prev)}
                  aria-label={reveal ? "Hide password" : "Show password"}
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1.5 text-muted transition hover:text-white"
                >
                  {reveal ? <EyeOff className="h-4 w-4" aria-hidden /> : <Eye className="h-4 w-4" aria-hidden />}
                </button>
              </div>
            </div>

            <div className="flex justify-end">
              <Link
                href="/login"
                className="text-xs font-semibold text-flame-400 transition hover:text-flame"
              >
                Forgot password?
              </Link>
            </div>

            {error ? (
              <p role="alert" className="rounded-tile border border-flame/40 bg-flame/10 px-3 py-2 text-xs text-flame-400">
                {error}
              </p>
            ) : null}

            <PrimaryButton type="submit" variant="flame" size="lg" full loading={busy}>
              Sign In
            </PrimaryButton>
          </form>

          <p className="mt-4 text-center text-[13px] text-muted">
            New to TaskCash Pro?{" "}
            <Link href="/login" className="font-semibold text-flame-400 transition hover:text-flame">
              Create an Account
            </Link>
          </p>
        </div>

        <div className="mt-4 flex items-start gap-2.5 rounded-tile border border-hairline bg-card/60 px-3.5 py-3">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-brand-400" aria-hidden />
          <p className="text-[11px] leading-relaxed text-muted">
            <span className="font-semibold text-white/90">Demo mode.</span> TaskCash Pro is a rewards
            platform prototype. Sign-in is mocked, balances are mock data stored in your browser, and
            no real payments are processed.
          </p>
        </div>
      </div>
    </div>
  );
}
