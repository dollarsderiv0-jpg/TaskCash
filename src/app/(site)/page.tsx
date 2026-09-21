import Link from "next/link";
import type { Metadata } from "next";
import {
  ArrowRight,
  BadgeCheck,
  Banknote,
  BookOpenCheck,
  Clock,
  Coins,
  Gift,
  Lock,
  Receipt,
  ShieldCheck,
  Smartphone,
  Users,
} from "lucide-react";
import { Badge, Separator } from "@/components/ui/misc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatMoney } from "@/lib/money/format";
import { getPublicSettings } from "@/lib/settings";
import { Sponsors } from "@/components/marketing/sponsors";
import { CompanyShowcase } from "@/components/marketing/company-showcase";

export const metadata: Metadata = {
  title: "TaskCash Pro — Turn Your Screen Time Into Rewards",
  description:
    "Complete eligible online activities, watch sponsored content, and earn rewards from participating campaigns.",
};

// Limits and rates are admin-configured, so the marketing copy reads them from
// the same source the product uses rather than hardcoding claims.
export const dynamic = "force-dynamic";

export default async function LandingPage() {
  const settings = await getPublicSettings();
  const referralRate = `${Math.round(settings.level1Rate * 100)}%`;

  return (
    <>
      {/* ---------------------------------------------------------------- */}
      {/* Hero                                                             */}
      {/* ---------------------------------------------------------------- */}
      <section className="tc-hero-glow relative overflow-hidden border-b border-border">
        <div className="container grid gap-12 py-16 lg:grid-cols-2 lg:py-24">
          <div className="flex flex-col justify-center">
            <Badge variant="success" className="w-fit">
              <BadgeCheck className="h-3.5 w-3.5" aria-hidden />
              Real rewards. Transparent ledger.
            </Badge>

            <h1 className="mt-5 text-4xl font-bold leading-[1.08] tracking-tight sm:text-5xl lg:text-6xl">
              Turn Your Screen Time Into <span className="tc-gradient-text">Rewards</span>
            </h1>

            <p className="mt-5 max-w-xl text-base leading-relaxed text-muted-foreground sm:text-lg">
              Complete eligible online activities, watch sponsored content, and earn rewards from
              participating campaigns.
            </p>

            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <Button asChild size="lg">
                <Link href="/register">
                  Start Earning
                  <ArrowRight className="h-4 w-4" aria-hidden />
                </Link>
              </Button>
              <Button asChild size="lg" variant="outline">
                <Link href="/how-it-works">How It Works</Link>
              </Button>
            </div>

            {/*
              No amounts here on purpose. The deposit floor and ceiling and the
              withdrawal minimum are not published on the public site — they are
              shown inside the app, on the signed-in wallet screen. What is left
              states the shape of the product without quoting a figure.
            */}
            <dl className="mt-10 grid grid-cols-2 gap-x-6 gap-y-4 text-sm sm:grid-cols-3">
              <Stat label="Rewards come from" value="Eligible sponsored campaigns" />
              <Stat label="Every payout" value="Reviewed before it is sent" />
              <Stat label="Referral commission" value={`${referralRate} of eligible activity`} />
            </dl>

            <p className="mt-6 max-w-xl text-xs leading-relaxed text-muted-foreground">
              Reward amounts are set per campaign and depend on the campaign budget and your
              eligibility. Withdrawals are reviewed by our administration team before payment is
              sent. Nothing on this page is a guarantee of income.
            </p>
          </div>

          {/* Product preview: a faithful mock of the real dashboard layout. */}
          <div className="flex items-center justify-center">
            <div className="w-full max-w-sm rounded-3xl border border-border bg-card p-5 shadow-2xl">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">
                    Wallet balance
                  </p>
                  <p className="mt-1 text-3xl font-bold tracking-tight">{formatMoney(0, "KES")}</p>
                </div>
                <div className="flex h-11 w-11 items-center justify-center rounded-full bg-orangeBrand-500/15">
                  <Coins className="h-5 w-5 text-orangeBrand-500" aria-hidden />
                </div>
              </div>

              <div className="mt-5 grid grid-cols-2 gap-3">
                <MiniCard label="Available" value={formatMoney(0, "KES")} />
                <MiniCard label="Locked" value={formatMoney(0, "KES")} />
                <MiniCard label="Today's earnings" value={formatMoney(0, "KES")} />
                <MiniCard label="This month" value={formatMoney(0, "KES")} />
              </div>

              <Separator className="my-5" />

              <div className="space-y-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Recent activity
                </p>
                <div className="rounded-xl border border-dashed border-border px-4 py-6 text-center">
                  <p className="text-sm font-medium">No transactions yet</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Your ledger entries appear here as soon as you complete your first activity.
                  </p>
                </div>
              </div>

              <p className="mt-5 text-center text-[11px] text-muted-foreground">
                Illustrative layout — balances shown are zero until real activity is recorded.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ---------------------------------------------------------------- */}
      {/* Sponsored pictures                                               */}
      {/* ---------------------------------------------------------------- */}
      {/*
        Placed high on the page on purpose — this is the advertising slot.

        It renders itself away when there is nothing live to show, including when
        migrations 0009/0013 have not been applied on this deployment, so the
        landing page can never break or flash an empty box because of an advert.
      */}
      <Sponsors />

      {/* ---------------------------------------------------------------- */}
      {/* Company pictures                                                 */}
      {/* ---------------------------------------------------------------- */}
      {/*
        Operator-supplied company pictures, listed in src/content/company-images.ts
        and stored in public/companies/. Renders itself away while that list is
        empty, for the same reason the advertising slot above does.
      */}
      <CompanyShowcase />

      {/* ---------------------------------------------------------------- */}
      {/* Trust                                                            */}
      {/* ---------------------------------------------------------------- */}
      <section className="border-b border-border bg-card/40">
        <div className="container py-14">
          <h2 className="text-center text-2xl font-bold tracking-tight">
            Built for real-money operations
          </h2>
          <p className="mx-auto mt-2 max-w-2xl text-center text-sm text-muted-foreground">
            These are product capabilities, not claims about our size or licensing.
          </p>

          <div className="mt-9 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            <TrustCard
              icon={Receipt}
              title="Secure wallet accounting"
              body="Every money movement creates an immutable ledger entry with a unique reference. Balances are never edited directly."
            />
            <TrustCard
              icon={BookOpenCheck}
              title="Transparent transactions"
              body="You can see the type, amount, status, reference and date of every entry that affects your wallet."
            />
            <TrustCard
              icon={ShieldCheck}
              title="Verified payment processing"
              body="Deposits are only credited after our payment partner independently confirms the transaction."
            />
            <TrustCard
              icon={Gift}
              title="Referral rewards"
              body="Earn commission on eligible activity from people you invite — with a qualifying-event rule to prevent abuse."
            />
            <TrustCard
              icon={Smartphone}
              title="Mobile-first experience"
              body="Install TaskCash Pro to your home screen and use it like a native app."
            />
          </div>
        </div>
      </section>

      {/* ---------------------------------------------------------------- */}
      {/* How it works                                                     */}
      {/* ---------------------------------------------------------------- */}
      <section className="border-b border-border">
        <div className="container py-16">
          <h2 className="text-2xl font-bold tracking-tight sm:text-3xl">How TaskCash Pro Works</h2>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
            Four steps, in order. Rewards are only issued when the platform can verify the activity.
          </p>

          <ol className="mt-9 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
            <StepCard
              step={1}
              title="Create your account"
              body="Register with your name, email and mobile money number. Your wallet and referral code are created automatically."
            />
            <StepCard
              step={2}
              title="Complete eligible activities"
              body="Watch sponsored videos through to the required duration, or complete an approved task. Our servers track the time."
            />
            <StepCard
              step={3}
              title="Get verified rewards"
              body="When the watch requirement is met, the reward is calculated server-side and written to your wallet ledger."
            />
            <StepCard
              step={4}
              title="Request a withdrawal"
              body="Request a payout to your mobile money number. An administrator reviews it before payment, and the app shows you the amounts involved."
            />
          </ol>

          <div className="mt-8">
            <Button asChild variant="outline">
              <Link href="/how-it-works">
                Read the full process
                <ArrowRight className="h-4 w-4" aria-hidden />
              </Link>
            </Button>
          </div>
        </div>
      </section>

      {/* ---------------------------------------------------------------- */}
      {/* Watch & earn / Referral / Wallet                                 */}
      {/* ---------------------------------------------------------------- */}
      <section className="border-b border-border bg-card/40">
        <div className="container grid gap-6 py-16 lg:grid-cols-3">
          <Pillar
            icon={Clock}
            title="Watch & Earn"
            points={[
              "Each campaign sets its own duration, required watch time and reward.",
              "Daily limits, cooldowns and campaign budgets are enforced on the server.",
              "Progress is measured against real elapsed time, not your device clock.",
            ]}
            href="/earn"
            cta="See earning activities"
          />
          <Pillar
            icon={Users}
            title="Referral Program"
            points={[
              `Current direct commission: ${referralRate} of a qualifying referral's eligible deposit.`,
              "Commissions only accrue after the configured qualifying event.",
              "Self-referrals, duplicates and circular referrals are blocked in the database.",
            ]}
            href="/referrals"
            cta="How referrals work"
          />
          <Pillar
            icon={Banknote}
            title="Wallet & Withdrawals"
            points={[
              "Available and locked balances are always shown separately.",
              "Requesting a withdrawal moves funds to locked — they are held, not spent.",
              "If a request is rejected, the held funds return to your available balance.",
            ]}
            href="/withdrawal-policy"
            cta="Read the withdrawal policy"
          />
        </div>
      </section>

      {/* ---------------------------------------------------------------- */}
      {/* Security                                                         */}
      {/* ---------------------------------------------------------------- */}
      <section className="border-b border-border">
        <div className="container py-16">
          <div className="max-w-3xl">
              <h2 className="text-2xl font-bold tracking-tight sm:text-3xl">Security</h2>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                Reward amounts, balances and transaction statuses are decided by our servers — never
                by the browser. Your account can read your own records and nothing else.
              </p>
              <ul className="mt-6 space-y-3 text-sm">
                {[
                  "Row-level security means you can only ever read your own wallet, ledger, deposits, withdrawals and referrals.",
                  "Reward values come from the campaign record. The app never accepts a reward amount from your device.",
                  "Duplicate rewards, duplicate webhook credits and double-paid withdrawals are prevented by unique database constraints and idempotency keys.",
                  "Suspicious activity is scored and sent to a human review queue — it never triggers an automatic ban.",
                ].map((item) => (
                  <li key={item} className="flex gap-3">
                    <Lock className="mt-0.5 h-4 w-4 shrink-0 text-orangeBrand-500" aria-hidden />
                    <span className="text-muted-foreground">{item}</span>
                  </li>
                ))}
              </ul>
          </div>
        </div>
      </section>

      {/* ---------------------------------------------------------------- */}
      {/* FAQ teaser + CTA                                                 */}
      {/* ---------------------------------------------------------------- */}
      <section className="border-b border-border bg-card/40">
        <div className="container py-16">
          <h2 className="text-2xl font-bold tracking-tight sm:text-3xl">
            Frequently Asked Questions
          </h2>
          <div className="mt-8 grid gap-5 sm:grid-cols-2">
            <FaqItem
              q="How much can I earn?"
              a="Each campaign publishes its own reward per completed activity. The amount you can earn depends on which campaigns are active, their remaining budget, and the daily limits that apply to your account. We do not advertise a fixed daily or monthly figure."
            />
            <FaqItem
              q="When do withdrawals get paid?"
              a="Withdrawal requests are reviewed by our administration team. After approval, payment is sent to your mobile money number through our payment partner."
            />
            <FaqItem
              q="Why is my balance split into available and locked?"
              a="Locked funds are amounts reserved by a withdrawal request that has not finished processing yet. Available funds are the ones you can use for a new request."
            />
            <FaqItem
              q="Do I need to deposit to earn?"
              a="Earning is driven by completing eligible activities. Some platform plans may require a deposit; the current requirement is always shown on the deposit screen, and it is never presented as an investment."
            />
          </div>

          <div className="mt-8">
            <Button asChild variant="outline">
              <Link href="/faq">See all questions</Link>
            </Button>
          </div>
        </div>
      </section>

      <section className="container py-16">
        <div className="tc-hero-glow flex flex-col items-center gap-5 rounded-3xl border border-border px-6 py-14 text-center">
          <h2 className="max-w-2xl text-3xl font-bold tracking-tight sm:text-4xl">
            Start with one eligible activity
          </h2>
          <p className="max-w-xl text-sm text-muted-foreground">
            Create an account, open the watch page, and complete your first sponsored campaign. Your
            wallet ledger will show the result immediately.
          </p>
          <div className="flex flex-col gap-3 sm:flex-row">
            <Button asChild size="lg">
              <Link href="/register">
                Start Earning
                <ArrowRight className="h-4 w-4" aria-hidden />
              </Link>
            </Button>
            <Button asChild size="lg" variant="outline">
              <Link href="/login">I already have an account</Link>
            </Button>
          </div>
        </div>
      </section>
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* Local presentational pieces                                                */
/* -------------------------------------------------------------------------- */

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-sm font-semibold">{value}</dd>
    </div>
  );
}

function MiniCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-border bg-background/60 p-3">
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-1 text-sm font-semibold">{value}</p>
    </div>
  );
}

function TrustCard({
  icon: Icon,
  title,
  body,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  body: string;
}) {
  return (
    <Card className="h-full transition-shadow hover:shadow-md">
      <CardContent className="space-y-3 p-5">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-secondary">
          <Icon className="h-5 w-5 text-orangeBrand-500" aria-hidden />
        </div>
        <p className="font-semibold">{title}</p>
        <p className="text-sm leading-relaxed text-muted-foreground">{body}</p>
      </CardContent>
    </Card>
  );
}

function StepCard({ step, title, body }: { step: number; title: string; body: string }) {
  return (
    <li className="rounded-2xl border border-border bg-card p-5">
      <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-primary/12 text-sm font-bold text-primary">
        {step}
      </span>
      <p className="mt-3 font-semibold">{title}</p>
      <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{body}</p>
    </li>
  );
}

function Pillar({
  icon: Icon,
  title,
  points,
  href,
  cta,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  points: string[];
  href: string;
  cta: string;
}) {
  return (
    <Card className="flex h-full flex-col">
      <CardHeader className="pb-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-orangeBrand-500/12">
          <Icon className="h-5 w-5 text-orangeBrand-500" aria-hidden />
        </div>
        <CardTitle className="mt-3 text-lg">{title}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col justify-between gap-5">
        <ul className="space-y-2.5 text-sm text-muted-foreground">
          {points.map((point) => (
            <li key={point} className="flex gap-2.5">
              <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-orangeBrand-500/70" />
              <span>{point}</span>
            </li>
          ))}
        </ul>
        <Link
          href={href}
          className="inline-flex items-center gap-1.5 text-sm font-semibold text-primary hover:underline"
        >
          {cta}
          <ArrowRight className="h-3.5 w-3.5" aria-hidden />
        </Link>
      </CardContent>
    </Card>
  );
}

function FaqItem({ q, a }: { q: string; a: string }) {
  return (
    <div className="rounded-2xl border border-border bg-card p-5">
      <p className="font-semibold">{q}</p>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{a}</p>
    </div>
  );
}
