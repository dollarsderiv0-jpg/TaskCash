import Link from "next/link";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Clock,
  Coins,
  Gift,
  Lock,
  Megaphone,
  Package,
  PlayCircle,
  Receipt,
  UserRound,
  Users,
} from "lucide-react";
import { guardPage } from "@/lib/auth/guards";
import { getEarningsSummary, getWalletOverview, listWalletTransactions } from "@/server/services/wallet";
import { getWithdrawalPreview } from "@/server/services/withdrawals";
import { getReferralStats } from "@/server/services/referrals";
import { StatCard } from "@/components/app/stat-card";
import { OnboardingChecklist, type OnboardingStep } from "@/components/app/onboarding-checklist";
import { EarningsChart } from "@/components/app/earnings-chart";
import { TransactionList } from "@/components/app/transaction-list";
import { CompanySlideshow } from "@/components/app/company-slideshow";
import { ComplianceDocuments } from "@/components/app/compliance-documents";
import { listShowcaseCompanyImages } from "@/server/services/company-images";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge, Separator } from "@/components/ui/misc";
import { Button } from "@/components/ui/button";
import { formatMoney } from "@/lib/money/format";
import { statusLabel } from "@/lib/types";

export const dynamic = "force-dynamic";

function greeting() {
  const hour = new Date().getHours();
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  return "Good evening";
}

export default async function DashboardPage() {
  const session = await guardPage();
  const userId = session.profile.id;

  const [overview, earnings, recent, preview, referralStats] = await Promise.all([
    getWalletOverview(userId),
    getEarningsSummary(userId),
    listWalletTransactions(userId, { pageSize: 6 }),
    getWithdrawalPreview({ profile: session.profile, wallet: session.wallet }),
    getReferralStats(userId),
  ]);

  const currency = session.wallet.currency;
  const available = Number(session.wallet.available_balance);
  const locked = Number(session.wallet.locked_balance);

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
      description: "See which sponsored videos are open to you right now.",
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

        Packages sits second on purpose. It is the only way to reach the packages
        page from a phone at all: the sidebar entry and the top-bar button are both
        `lg:`-only, and the bottom bar is a fixed five. It also belongs next to
        Watch & Earn rather than with the money links, because a package is what
        you buy in order to earn more.
      */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <ActionTile
          href="/dashboard/watch"
          label="Watch & Earn"
          icon={PlayCircle}
          tone="primary"
        />
        <ActionTile href="/dashboard/packages" label="Packages" icon={Package} />
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

      {/* Chart + withdrawal summary */}
      <div className="grid gap-5 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Earnings · last 30 days</CardTitle>
            <CardDescription>Recorded reward credits from your wallet ledger.</CardDescription>
          </CardHeader>
          <CardContent>
            <EarningsChart data={earnings.earningsSeries} currency={currency} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Withdrawal readiness</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            {/*
              Available, and the two things that could stop a withdrawal
              outright. The floor, the fee and the rolling limit are NOT shown
              here: they belong to the wallet screen inside the app, which is the
              only place they are displayed at all.
            */}
            <Row label="Available" value={formatMoney(available, currency)} />
            <Separator />
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Account status</span>
                <Badge variant={session.profile.status === "ACTIVE" ? "success" : "warning"}>
                  {statusLabel(session.profile.status)}
                </Badge>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Verification</span>
                <Badge variant={session.profile.kyc_status === "VERIFIED" ? "success" : "default"}>
                  {statusLabel(session.profile.kyc_status)}
                </Badge>
              </div>
            </div>
            <Button asChild className="w-full">
              <Link href="/dashboard/withdraw">
                {available >= preview.minimum ? "Request withdrawal" : "View withdrawal details"}
              </Link>
            </Button>
          </CardContent>
        </Card>
      </div>

      {/* Recent transactions */}
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <div>
            <CardTitle>Recent transactions</CardTitle>
            <CardDescription>Newest ledger entries first.</CardDescription>
          </div>
          <Button asChild variant="ghost" size="sm">
            <Link href="/dashboard/wallet">View all</Link>
          </Button>
        </CardHeader>
        <CardContent>
          <TransactionList transactions={recent.items} />
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
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-semibold tabular-nums">{value}</span>
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
