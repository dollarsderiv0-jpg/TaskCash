import Link from "next/link";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Clock,
  Coins,
  Gift,
  Lock,
  Megaphone,
  PlayCircle,
  Receipt,
  UserRound,
  Users,
} from "lucide-react";
import { guardPage } from "@/lib/auth/guards";
import { getEarningsSummary, getWalletOverview } from "@/server/services/wallet";
import { getReferralStats } from "@/server/services/referrals";
import { listPackageCatalogue } from "@/server/services/packages";
import { StatCard } from "@/components/app/stat-card";
import { OnboardingChecklist, type OnboardingStep } from "@/components/app/onboarding-checklist";
import { ActivityTicker } from "@/components/app/activity-ticker";
import { listRecentActivity } from "@/server/services/activity";
import { CompanySlideshow } from "@/components/app/company-slideshow";
import { ComplianceDocuments } from "@/components/app/compliance-documents";
import { listShowcaseCompanyImages } from "@/server/services/company-images";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { formatMoney } from "@/lib/money/format";

export const dynamic = "force-dynamic";

/*
  WHAT THIS PAGE NO LONGER CARRIES, AND WHY
  -----------------------------------------
  Three blocks were removed at the product owner's request: the 30-day earnings
  chart, the withdrawal-readiness summary, and the recent-transactions list.

  They were removed rather than hidden, and nothing was left behind — no empty
  card, no heading over nothing, no gap in the layout. Two of them also had a
  real cost beyond the space they took: the chart, "no earnings recorded yet" and
  an empty transaction list were all ways of telling a brand-new account, three
  times over, that it had earned nothing. The wallet balance and the one action
  that changes it say that once, and say what to do about it.

  The earnings summary is still read, because the stat cards below use it; what
  went is the chart, not the numbers behind it. Nothing else moved, and no other
  screen was touched.
*/

function greeting() {
  const hour = new Date().getHours();
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  return "Good evening";
}

export default async function DashboardPage() {
  const session = await guardPage();
  const userId = session.profile.id;

  /*
    The activity feed is the one query here that reads OTHER people's rows. The
    identities are reduced at the source (see listRecentActivity) and the
    caller's own id is passed in so their own movements are excluded rather than
    shown back to them as news.
  */
  const [overview, earnings, referralStats, activity, catalogue] = await Promise.all([
    getWalletOverview(userId),
    getEarningsSummary(userId),
    getReferralStats(userId),
    listRecentActivity({ viewerProfileId: userId }),
    /*
      Only what is needed to summarise: which packages this account holds, and how
      many are on sale. The catalogue itself belongs on Watch & Earn — a second
      copy of it here would be two places to change every time a tier is edited.
    */
    listPackageCatalogue(userId),
  ]);

  const currency = session.wallet.currency;
  const available = Number(session.wallet.available_balance);
  const locked = Number(session.wallet.locked_balance);

  const heldPackages = catalogue.packages.filter((tier) => tier.owned && !tier.expired);
  const availablePackages = catalogue.packages.filter((tier) => !tier.owned);
  const packageEarnings = heldPackages.reduce((sum, tier) => sum + tier.earnedToday, 0);

  // Database rows when there are any, otherwise the pictures bundled with the
  // app — see listShowcaseCompanyImages(). Never throws for a missing table.
  const showcaseImages = await listShowcaseCompanyImages();

  /*
    Each step is wired to a fact the account has actually produced, so the
    checklist cannot claim progress that did not happen: a filled-in phone
    number, a confirmed email, a watched session, a credited reward, a recorded
    referral. The final invitation step is optional — it never blocks anyone.
  */
  const onboardingSteps: OnboardingStep[] = [
    {
      key: "profile",
      title: "Complete your profile",
      description: "Add your mobile money number so payouts have somewhere to go.",
      href: "/dashboard/profile",
      action: "Open",
      done: Boolean(session.profile.phone && session.profile.phone.trim().length >= 7),
    },
    {
      key: "email",
      title: "Verify your email",
      description: "We send a link to confirm the address on your account.",
      href: "/verify-email",
      action: "Verify",
      done: session.emailConfirmed,
    },
    {
      key: "watch",
      title: "Explore available tasks",
      description: "See which packages and sponsored videos are open to you right now.",
      href: "/dashboard/watch",
      action: "View",
      done: earnings.videosCompleted > 0,
    },
    {
      key: "earn",
      title: "Start earning rewards",
      description: "Finish one eligible activity and your first reward lands here.",
      href: "/dashboard/watch",
      action: "Start",
      done: (overview?.totalEarned ?? 0) > 0,
    },
    {
      key: "refer",
      title: "Invite friends",
      description: "Share your link and you can earn when they qualify.",
      href: "/dashboard/referrals",
      action: "Invite",
      done: referralStats.totalReferrals > 0,
      optional: true,
    },
  ];

  return (
    <div className="space-y-6">
      {/* Greeting */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight">
          {greeting()}, {session.profile.full_name.split(" ")[0]}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Here is where your account stands right now.
        </p>
      </div>

      {/*
        The company pictures, rotating, for every user who signs in. Renders
        nothing at all when there is nothing to show, so it can never leave an
        empty frame at the top of the dashboard.
      */}
      <CompanySlideshow images={showcaseImages} />

      {/*
        Directly under the slideshow, as asked. Deliberately just the button:
        the two registration scans open in a dialog rather than pushing the
        wallet balance further down the page for everyone who does not tap it.
      */}
      <div>
        <ComplianceDocuments />
      </div>

      <OnboardingChecklist steps={onboardingSteps} />

      {/* Balance hero */}
      <Card className="overflow-hidden">
        <div className="tc-hero-glow">
          <CardContent className="grid gap-6 p-5 sm:grid-cols-2">
            <div>
              <p className="text-xs uppercase tracking-wide text-muted-foreground">
                Wallet balance · {currency}
              </p>
              <p className="mt-1.5 text-4xl font-bold tracking-tight tabular-nums">
                {formatMoney(available + locked, currency)}
              </p>
              <div className="mt-4 grid grid-cols-2 gap-4">
                <div>
                  <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Coins className="h-3.5 w-3.5" aria-hidden />
                    Available
                  </p>
                  <p className="mt-0.5 text-sm font-semibold tabular-nums">
                    {formatMoney(available, currency)}
                  </p>
                </div>
                <div>
                  <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Lock className="h-3.5 w-3.5" aria-hidden />
                    Locked
                  </p>
                  <p className="mt-0.5 text-sm font-semibold tabular-nums">
                    {formatMoney(locked, currency)}
                  </p>
                </div>
              </div>
              {locked > 0 ? (
                <p className="mt-3 text-xs text-muted-foreground">
                  Locked funds are reserved by a withdrawal request that is still being reviewed.
                </p>
              ) : null}

              {/*
                A brand-new account lands here at exactly zero, and the first
                version showed a bare "KES 0.00" — which reads as something being
                broken or missing. Zero is the correct starting balance, so the
                page says so and points at the one action that changes it.
              */}
              {available + locked === 0 ? (
                <div className="mt-4 rounded-lg border border-dashed border-border p-3">
                  <p className="text-sm font-semibold">Your wallet is ready</p>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                    Nothing has been earned yet, and that is exactly where everyone starts. Complete
                    eligible activities and your rewards will appear here.
                  </p>
                  <Link
                    href="/dashboard/watch"
                    className="mt-3 inline-flex min-h-11 items-center justify-center rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground"
                  >
                    VIEW AVAILABLE TASKS
                  </Link>
                </div>
              ) : null}
            </div>

            <div className="grid grid-cols-2 gap-4 sm:border-l sm:border-border sm:pl-6">
              <div>
                <p className="text-xs uppercase tracking-wide text-muted-foreground">
                  Today&apos;s earnings
                </p>
                <p className="mt-1 text-xl font-bold tabular-nums tc-amount-in">
                  {formatMoney(earnings.todayEarnings, currency)}
                </p>
              </div>
              <div>
                <p className="text-xs uppercase tracking-wide text-muted-foreground">This month</p>
                <p className="mt-1 text-xl font-bold tabular-nums">
                  {formatMoney(earnings.monthEarnings, currency)}
                </p>
              </div>
              <div>
                <p className="text-xs uppercase tracking-wide text-muted-foreground">
                  Total deposited
                </p>
                <p className="mt-1 text-xl font-bold tabular-nums">
                  {formatMoney(overview?.totalDeposited ?? 0, currency)}
                </p>
              </div>
              <div>
                <p className="text-xs uppercase tracking-wide text-muted-foreground">
                  Total withdrawn
                </p>
                <p className="mt-1 text-xl font-bold tabular-nums">
                  {formatMoney(overview?.totalWithdrawn ?? 0, currency)}
                </p>
              </div>
            </div>
          </CardContent>
        </div>
      </Card>

      {/*
        Primary actions. The last tile is the sponsored gallery, which pays
        nothing — it is labelled "Advertisements" rather than given a money-ish
        name, because sitting in this row is otherwise the strongest possible
        hint that tapping it earns something.

        There is no longer a separate Packages tile: the catalogue and its
        payment flow live on Watch & Earn now, so a second tile pointing there
        would be the same destination under two names.
      */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <ActionTile
          href="/dashboard/watch"
          label="Watch & Earn"
          icon={PlayCircle}
          tone="primary"
        />
        <ActionTile href="/dashboard/deposit" label="Deposit" icon={ArrowDownToLine} />
        <ActionTile href="/dashboard/withdraw" label="Withdraw" icon={ArrowUpFromLine} />
        <ActionTile href="/dashboard/referrals" label="Referrals" icon={Gift} />
        <ActionTile href="/dashboard/ads" label="Advertisements" icon={Megaphone} />
      </div>

      {/* Stat cards */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Today's earnings"
          value={formatMoney(earnings.todayEarnings, currency)}
          hint="Rewards credited today"
          icon={Coins}
          tone="success"
        />
        <StatCard
          label="Available balance"
          value={formatMoney(available, currency)}
          hint="Ready to withdraw"
          icon={Receipt}
        />
        <StatCard
          label="Pending withdrawal"
          value={formatMoney(overview?.pendingWithdrawal ?? 0, currency)}
          hint="Awaiting admin review"
          icon={Clock}
          tone="warning"
        />
        <StatCard
          label="Videos completed"
          value={String(earnings.videosCompleted)}
          hint={`${referralStats.qualifyingReferrals} qualifying referral(s)`}
          icon={Users}
        />
      </div>

      {/*
        Packages, summarised. Deliberately NOT the catalogue: the card lists only
        what this account holds — with what it has earned today — plus a count of
        what is on sale, and sends anyone who wants to compare tiers to Watch &
        Earn. Duplicating the cards here would mean two renderings of the same
        price to keep in step, on the one screen that is not about buying.
      */}
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <div>
            <CardTitle>Your packages</CardTitle>
            <CardDescription>
              {heldPackages.length > 0
                ? "Each package earns up to its own daily limit, which resets at midnight."
                : "No package is active yet."}
            </CardDescription>
          </div>
          <Button asChild variant="ghost" size="sm">
            <Link href="/dashboard/watch">
              {heldPackages.length > 0 ? "Open Watch & Earn" : "Browse packages"}
            </Link>
          </Button>
        </CardHeader>
        <CardContent className="space-y-3">
          {heldPackages.length === 0 ? (
            <p className="text-sm leading-relaxed text-muted-foreground">
              {availablePackages.length > 0
                ? `${availablePackages.length} package${
                    availablePackages.length === 1 ? "" : "s"
                  } available on Watch & Earn. Activating one gives you access to its videos, and rewards are credited once our server verifies your watch time.`
                : "No packages are on sale right now. Please check back shortly."}
            </p>
          ) : (
            <>
              {heldPackages.map((tier) => {
                const daysLeft = tier.expiresAt
                  ? Math.max(
                      0,
                      Math.ceil(
                        (new Date(tier.expiresAt).getTime() - Date.now()) / (24 * 60 * 60 * 1000),
                      ),
                    )
                  : null;

                return (
                  <div
                    key={tier.id}
                    className="flex items-center justify-between gap-3 rounded-xl border border-border p-3"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold">{tier.name}</p>
                      <p className="mt-0.5 text-xs tabular-nums text-muted-foreground">
                        {formatMoney(tier.earnedToday, currency, { decimals: 0 })} of{" "}
                        {formatMoney(tier.daily_earning_cap, currency, { decimals: 0 })} earned today
                        {daysLeft !== null
                          ? ` · ${daysLeft} day${daysLeft === 1 ? "" : "s"} left`
                          : ""}
                      </p>
                    </div>
                    <Button asChild size="sm" variant="outline">
                      <Link href={`/dashboard/watch?package=${tier.id}`}>Watch</Link>
                    </Button>
                  </div>
                );
              })}

              {packageEarnings === 0 ? (
                <p className="text-xs text-muted-foreground">
                  Nothing earned from a package yet today. Its allowance resets at midnight (East
                  Africa Time).
                </p>
              ) : null}
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <UserRound className="h-4 w-4 text-muted-foreground" aria-hidden />
            Your referral code
          </CardTitle>
          <CardDescription>
            Share it and you can earn commission once your referral qualifies.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-3">
          <code className="rounded-xl border border-border bg-background px-4 py-2 font-mono text-sm">
            {session.profile.referral_code}
          </code>
          <Button asChild variant="outline" size="sm">
            <Link href="/dashboard/referrals">Open referral dashboard</Link>
          </Button>
        </CardContent>
      </Card>

      {/*
        Fixed-position at the top of the viewport, so its place in the tree is
        irrelevant. Absent entirely when there is nothing real to show — the
        component returns null rather than inventing movement.
      */}
      <ActivityTicker initialItems={activity.items} />
    </div>
  );
}

function ActionTile({
  href,
  label,
  icon: Icon,
  tone = "default",
}: {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  tone?: "default" | "primary";
}) {
  return (
    <Link
      href={href}
      className={
        tone === "primary"
          ? "flex flex-col items-center gap-2 rounded-2xl border border-primary/30 bg-primary/10 p-4 text-center transition-colors hover:bg-primary/15"
          : "flex flex-col items-center gap-2 rounded-2xl border border-border bg-card p-4 text-center transition-colors hover:bg-secondary/60"
      }
    >
      <Icon className={tone === "primary" ? "h-5 w-5 text-primary" : "h-5 w-5 text-muted-foreground"} aria-hidden />
      <span className="text-xs font-semibold sm:text-sm">{label}</span>
    </Link>
  );
}
