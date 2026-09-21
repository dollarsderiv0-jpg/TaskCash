"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, Clock, Lock, Package as PackageIcon, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, Badge, EmptyState, Progress } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { apiRequest } from "@/lib/client/api";
import { useCountdown } from "@/lib/client/use-countdown";
import { formatMoney } from "@/lib/money/format";
import type { DepositBonusTier } from "@/server/services/packages";
import type { PackageWithUsage } from "@/lib/types";

/**
 * Which deposit bonus this price would earn, or null.
 *
 * The tiers arrive sorted descending from the server, and the first threshold the
 * price clears wins — the same rule `apply_deposit_bonus` applies in SQL, so the
 * page cannot advertise a tier the settlement function would not pay.
 */
function bonusFor(tiers: DepositBonusTier[], price: number): DepositBonusTier | null {
  return tiers.find((tier) => price >= tier.min) ?? null;
}

/**
 * The package catalogue.
 *
 * Two things this component is careful about:
 *
 *   · It never shows a balance or an allowance it computed itself. Every figure
 *     comes from the server render; a purchase ends with `router.refresh()` and
 *     the numbers are re-read. There is no optimistic balance anywhere.
 *   · The countdown is presentation only. The allowance that actually gates a
 *     reward is computed in the database against the operator's midnight, so a
 *     clock on this device that is wrong, paused or throttled cannot buy the
 *     user a single extra shilling.
 */

function AllowanceCard({ tier, currency }: { tier: PackageWithUsage; currency: string }) {
  const countdown = useCountdown(tier.resetsAt);

  const spent = Math.max(0, tier.daily_earning_cap - tier.remainingToday);
  const percent =
    tier.daily_earning_cap > 0 ? Math.min(100, (spent / tier.daily_earning_cap) * 100) : 0;
  const exhausted = tier.daily_earning_cap > 0 && tier.remainingToday <= 0;

  return (
    <div className="rounded-2xl border border-border bg-card p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Earned today from this package
          </p>
          <p className="mt-1 text-xl font-bold tracking-tight">
            {formatMoney(tier.earnedToday, currency)}
            <span className="ml-1.5 text-sm font-medium text-muted-foreground">
              of {formatMoney(tier.daily_earning_cap, currency)}
            </span>
          </p>
        </div>
        {exhausted ? (
          <Badge variant="warning">
            <Clock className="h-3 w-3" aria-hidden />
            Limit reached
          </Badge>
        ) : (
          <Badge variant="success">
            <CheckCircle2 className="h-3 w-3" aria-hidden />
            Active
          </Badge>
        )}
      </div>

      <Progress
        className="mt-3"
        value={percent}
        label={`Package allowance used: ${Math.round(percent)}%`}
      />

      <dl className="mt-3 grid grid-cols-2 gap-3 text-sm">
        <div>
          <dt className="text-xs text-muted-foreground">Still available today</dt>
          <dd className="mt-0.5 font-semibold">{formatMoney(tier.remainingToday, currency)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Allowance resets in</dt>
          <dd className="mt-0.5 font-semibold tabular-nums">{countdown ?? "—"}</dd>
        </div>
      </dl>

      {/*
        The lifetime ceiling and the term, for a package the user already owns. Both
        come from the purchase's own snapshot, so re-pricing the tier cannot move
        what this buyer was sold. `lifetimeRemaining === 0` is "finished", while
        null is "no ceiling" — the two must not render the same.
      */}
      {tier.lifetime_earning_cap || tier.expiresAt ? (
        <dl className="mt-3 grid grid-cols-2 gap-3 border-t border-border pt-3 text-sm">
          {tier.lifetime_earning_cap ? (
            <div>
              <dt className="text-xs text-muted-foreground">Left in total</dt>
              <dd className="mt-0.5 font-semibold">
                {formatMoney(tier.lifetimeRemaining ?? 0, currency)}
                <span className="ml-1 text-xs font-normal text-muted-foreground">
                  of {formatMoney(tier.lifetime_earning_cap, currency)}
                </span>
              </dd>
            </div>
          ) : null}
          {tier.expiresAt ? (
            <div>
              <dt className="text-xs text-muted-foreground">Earning until</dt>
              <dd className="mt-0.5 font-semibold">
                {new Date(tier.expiresAt).toLocaleDateString(undefined, {
                  day: "numeric",
                  month: "short",
                  year: "numeric",
                })}
              </dd>
            </div>
          ) : null}
        </dl>
      ) : null}

      {tier.lifetime_earning_cap && tier.lifetimeRemaining !== null && tier.lifetimeRemaining <= 0 ? (
        <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
          This package has paid its full earning allowance, so its videos no longer add to your
          balance. Activating it again starts a new allowance — the per-day and total limits apply
          to each purchase separately.
        </p>
      ) : exhausted ? (
        <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
          You have earned the full daily allowance from this package. It comes back at midnight
          (East Africa Time) — until then you can still earn from videos that are not part of a
          package.
        </p>
      ) : null}
    </div>
  );
}

function TierCard({
  tier,
  currency,
  balance,
  bonusTiers,
  onPurchased,
}: {
  tier: PackageWithUsage;
  currency: string;
  balance: number;
  bonusTiers: DepositBonusTier[];
  onPurchased: () => void;
}) {
  const { toast } = useToast();
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const affordable = balance >= tier.price;
  const bonus = bonusFor(bonusTiers, tier.price);

  async function buy() {
    setLoading(true);
    setError(null);

    const response = await apiRequest<{ message: string }>("/api/packages/purchase", {
      method: "POST",
      body: { packageId: tier.id },
    });

    if (!response.ok) {
      // The API's messages are already mapped to safe, human text server-side.
      setError(response.message);
      setLoading(false);
      return;
    }

    toast({ title: response.data.message, tone: "success" });
    setLoading(false);
    // Re-read the authoritative balance and allowance from the server rather
    // than adjusting anything locally.
    onPurchased();
  }

  return (
    <Card className="flex h-full flex-col">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-orangeBrand-500/12">
              <PackageIcon className="h-5 w-5 text-orangeBrand-500" aria-hidden />
            </span>
            <div>
              <CardTitle className="text-base">{tier.name}</CardTitle>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {tier.videoCount > 0
                  ? `${tier.videoCount} video${tier.videoCount === 1 ? "" : "s"} included`
                  : "Videos being added"}
              </p>
            </div>
          </div>
          {tier.owned ? (
            <Badge variant="success">Active</Badge>
          ) : (
            <Badge variant="outline">Not active</Badge>
          )}
        </div>
      </CardHeader>

      <CardContent className="flex flex-1 flex-col gap-4">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              One-time price
            </p>
            <p className="mt-1 text-lg font-bold tracking-tight">
              {formatMoney(tier.price, currency)}
            </p>
          </div>
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Daily earning limit
            </p>
            <p className="mt-1 text-lg font-bold tracking-tight">
              {tier.daily_earning_cap > 0
                ? formatMoney(tier.daily_earning_cap, currency)
                : "Not set"}
            </p>
          </div>
        </div>

        {tier.description ? (
          <p className="text-sm leading-relaxed text-muted-foreground">{tier.description}</p>
        ) : null}

        {/*
          The terms, as the database enforces them: a ceiling per day, a ceiling in
          total, and the window they apply to.

          This replaced a "potential 3-week estimate" that multiplied the daily cap
          by 21 and printed "net after package cost". Both halves were wrong once
          the tiers carried a 14-day term: the projection described a term that
          does not exist, and the net figure is a payback calculation — the one
          thing the schema's own note says a package page must never imply, because
          whether the ceiling is reached at all depends on the videos' campaigns.
        */}
        {tier.daily_earning_cap > 0 && !tier.owned ? (
          <div className="rounded-xl border border-orangeBrand-200 bg-orangeBrand-50 p-3">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-orangeBrand-700">
              Earning limits
            </p>
            <dl className="mt-1.5 space-y-1 text-xs text-orangeBrand-700">
              <div className="flex items-center justify-between gap-3">
                <dt>Per day</dt>
                <dd className="font-semibold">{formatMoney(tier.daily_earning_cap, currency)}</dd>
              </div>
              {tier.lifetime_earning_cap ? (
                <div className="flex items-center justify-between gap-3">
                  <dt>In total</dt>
                  <dd className="font-semibold">
                    {formatMoney(tier.lifetime_earning_cap, currency)}
                  </dd>
                </div>
              ) : null}
              {tier.duration_days ? (
                <div className="flex items-center justify-between gap-3">
                  <dt>Earning period</dt>
                  <dd className="font-semibold">{tier.duration_days} days</dd>
                </div>
              ) : null}
            </dl>
            <p className="mt-2 text-[11px] leading-relaxed text-orangeBrand-600">
              These are the most this package&apos;s videos can pay, not an amount they
              will pay. Each reward comes from a campaign with its own budget.
            </p>
          </div>
        ) : null}

        {/*
          The deposit bonus, read from the setting the settlement function reads.
          The applicable tier is the first whose threshold the price clears — the
          same "descending, first match wins" rule apply_deposit_bonus uses.
        */}
        {!tier.owned && bonus ? (
          <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-emerald-700">
              Deposit bonus
            </p>
            <p className="mt-1 text-sm font-bold text-emerald-800">
              +{formatMoney(bonus.bonus, currency)} credited on a deposit of{" "}
              {formatMoney(bonus.min, currency)} or more
            </p>
          </div>
        ) : null}

        {error ? (
          <p className="text-xs font-medium text-destructive" role="alert">
            {error}
          </p>
        ) : null}

        <div className="mt-auto">
          {tier.owned ? (
            <AllowanceCard tier={tier} currency={currency} />
          ) : tier.daily_earning_cap <= 0 ? (
            /*
              Fail-closed and stated plainly. The server would refuse this
              purchase (PACKAGE_NOT_AVAILABLE); showing a disabled button with
              the reason beats letting someone tap it and meet an error.
            */
            <Alert variant="warning" title="Not on sale yet">
              <p>
                This package is still being set up. Its daily earning limit has not been published
                yet, so it cannot be activated.
              </p>
            </Alert>
          ) : (
            <div className="space-y-3">
              <Button className="w-full" size="lg" loading={loading} onClick={buy} disabled={!affordable}>
                <Sparkles className="h-4 w-4" aria-hidden />
                {affordable
                  ? `Activate for ${formatMoney(tier.price, currency)}`
                  : "Not enough balance"}
              </Button>
              <p className="text-center text-xs text-muted-foreground">
                Paid from your wallet balance ({formatMoney(balance, currency)} available).
              </p>
              {!affordable ? (
                <p className="text-center text-xs font-medium text-destructive">
                  You need {formatMoney(tier.price - balance, currency)} more in your wallet.
                </p>
              ) : null}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

export function PackagesCatalogue({
  tiers,
  currency,
  balance,
  bonusTiers,
}: {
  tiers: PackageWithUsage[];
  currency: string;
  balance: number;
  bonusTiers: DepositBonusTier[];
}) {
  const router = useRouter();

  if (tiers.length === 0) {
    return (
      <EmptyState
        icon={PackageIcon}
        title="No packages available right now"
        description="Packages appear here as soon as an administrator publishes them."
      />
    );
  }

  return (
    <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
      {tiers.map((tier) => (
        <TierCard
          key={tier.id}
          tier={tier}
          currency={currency}
          balance={balance}
          bonusTiers={bonusTiers}
          onPurchased={() => router.refresh()}
        />
      ))}
    </div>
  );
}

/** Used when the packages table itself is missing on this deployment. */
export function PackagesUnavailable() {
  return (
    <EmptyState
      icon={Lock}
      title="This section is being set up"
      description="Packages are not available on this account yet. Please check back shortly."
    />
  );
}
