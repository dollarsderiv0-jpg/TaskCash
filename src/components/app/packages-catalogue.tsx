"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  CheckCircle2,
  Clock,
  Lock,
  Package as PackageIcon,
  RefreshCw,
  Smartphone,
  Sparkles,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox, Field, Input } from "@/components/ui/fields";
import { Alert, Badge, EmptyState, Progress } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { apiRequest, newIdempotencyKey } from "@/lib/client/api";
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

type PackagePaymentResult = {
  depositId: string;
  merchantReference: string;
  amount: number;
  currency: string;
  phone: string;
  status: string;
  message: string;
  packageName: string | null;
};

type PackagePaymentStatus = {
  status: string;
  credited: boolean;
  duplicate: boolean;
  message: string;
  paymentStatus: string;
  packageActivated?: { packageName: string } | null;
};

/**
 * Pay for a package directly by M-Pesa.
 *
 * The rule this component is built around: a successful request means an STK
 * prompt was SENT, and that is all it means. The package is stated as active only
 * when the server says the provider confirmed the payment AND that the activation
 * happened — `packageActivated` on the verify response, never a status this
 * component interprets for itself. The two are told apart deliberately: a
 * confirmed payment whose activation failed is a real outcome, and reporting it
 * as success would leave the buyer waiting for a package that is not coming.
 *
 * The price shown is the tier's; the amount sent is for shape only, and the
 * server discards it in favour of the package row's own price.
 */
function PayByMpesa({
  tier,
  currency,
  defaultPhone,
  onActivated,
  collapsed,
}: {
  tier: PackageWithUsage;
  currency: string;
  defaultPhone: string;
  onActivated: () => void;
  /** True when the wallet can already cover the price, so M-Pesa starts folded away. */
  collapsed: boolean;
}) {
  const { toast } = useToast();
  const [open, setOpen] = React.useState(!collapsed);
  const [phone, setPhone] = React.useState(defaultPhone);
  const [authorised, setAuthorised] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [checking, setChecking] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState<PackagePaymentResult | null>(null);

  const settle = React.useCallback(
    (result: PackagePaymentStatus) => {
      if (result.status === "COMPLETED") {
        setPending(null);
        toast({
          title: result.packageActivated
            ? `${result.packageActivated.packageName} is now active`
            : "Payment confirmed",
          description: result.message,
          tone: "success",
        });
        // Re-read the authoritative balance and allowance from the server rather
        // than adjusting anything locally.
        onActivated();
        return;
      }

      toast({
        title:
          result.status === "PENDING"
            ? "Still waiting on the provider"
            : "Payment not completed",
        description: result.message,
        tone: result.status === "PENDING" ? "info" : "warning",
      });

      // A terminal outcome is finished; PENDING keeps the prompt on screen so
      // the buyer can approve late rather than re-raising a second prompt.
      if (result.status !== "PENDING") setPending(null);
    },
    [onActivated, toast],
  );

  async function verify(depositId: string) {
    setChecking(true);

    const response = await apiRequest<PackagePaymentStatus>("/api/deposits/verify", {
      method: "POST",
      body: { depositId },
    });

    setChecking(false);

    if (!response.ok) {
      toast({ title: "Could not check yet", description: response.message, tone: "warning" });
      return;
    }

    settle(response.data);
  }

  /*
    Poll while a prompt is open.

    A confirmation usually lands within seconds of the buyer entering their PIN,
    and the alternative is someone staring at a screen that tells them nothing.
    Bounded to 15 attempts at 6 seconds — comfortably inside the verify
    endpoint's 30-per-10-minutes allowance — so a prompt that is never answered
    costs a handful of requests instead of a rate limit. The interval reads
    `pending.depositId` and not the component's other state, so it cannot be torn
    down and re-created on every render before its first tick ever fires.
  */
  React.useEffect(() => {
    if (!pending) return;

    let attempts = 0;

    const id = window.setInterval(() => {
      attempts += 1;
      if (attempts > 15) {
        window.clearInterval(id);
        return;
      }

      void apiRequest<PackagePaymentStatus>("/api/deposits/verify", {
        method: "POST",
        body: { depositId: pending.depositId },
      }).then((response) => {
        if (response.ok) settle(response.data);
      });
    }, 6000);

    return () => window.clearInterval(id);
  }, [pending, settle]);

  async function pay(event: React.FormEvent) {
    event.preventDefault();
    setError(null);

    if (phone.trim().length < 7) {
      setError("Enter the M-Pesa number to charge.");
      return;
    }
    if (!authorised) {
      setError("Please confirm you authorise this payment.");
      return;
    }

    setLoading(true);

    const response = await apiRequest<PackagePaymentResult>("/api/deposits/create", {
      method: "POST",
      // One key per attempt, so a double-tap or a retry cannot raise two prompts.
      body: {
        packageId: tier.id,
        amount: tier.price,
        phone: phone.trim(),
        idempotencyKey: newIdempotencyKey("package-payment"),
        acceptTerms: true,
      },
    });

    setLoading(false);

    if (!response.ok) {
      setError(response.message);
      return;
    }

    setPending(response.data);
    setAuthorised(false);
    toast({
      title: "Check your phone and enter your M-Pesa PIN",
      description:
        `Approve ${formatMoney(response.data.amount, response.data.currency)} sent to ` +
        `${response.data.phone}. ${tier.name} activates as soon as the payment is confirmed.`,
      tone: "info",
    });
  }

  if (!open) {
    return (
      <Button variant="outline" className="w-full" onClick={() => setOpen(true)}>
        <Smartphone className="h-4 w-4" aria-hidden />
        Or pay {formatMoney(tier.price, currency)} by M-Pesa
      </Button>
    );
  }

  if (pending) {
    return (
      <Alert variant="info" title="Check your phone and enter your M-Pesa PIN">
        <div className="space-y-3">
          <p>
            A payment prompt for {formatMoney(pending.amount, pending.currency)} was sent to{" "}
            {pending.phone}. {tier.name} activates as soon as the provider confirms the payment — this
            page checks by itself.
          </p>
          <p className="font-mono text-[11px]">Reference {pending.merchantReference}</p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => verify(pending.depositId)} loading={checking}>
              <RefreshCw className="h-4 w-4" aria-hidden />
              I have paid — check now
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setPending(null)}>
              Done
            </Button>
          </div>
        </div>
      </Alert>
    );
  }

  return (
    <form onSubmit={pay} className="space-y-3" noValidate>
      {error ? (
        <p className="text-xs font-medium text-destructive" role="alert">
          {error}
        </p>
      ) : null}

      <Field label="M-Pesa number" htmlFor={`mpesa-phone-${tier.id}`}>
        <Input
          id={`mpesa-phone-${tier.id}`}
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          placeholder="07XXXXXXXX"
          value={phone}
          onChange={(event) => setPhone(event.target.value)}
        />
      </Field>

      <label className="flex items-start gap-3 text-xs">
        <Checkbox
          checked={authorised}
          onCheckedChange={(checked) => setAuthorised(checked === true)}
          className="mt-0.5"
        />
        <span className="leading-relaxed text-muted-foreground">
          I authorise a payment of{" "}
          <strong className="text-foreground">{formatMoney(tier.price, currency)}</strong> to be
          collected from my M-Pesa account via our payment partner. I understand this is a payment for
          platform services and is not an investment.
        </span>
      </label>

      <Button type="submit" className="w-full" size="lg" loading={loading}>
        <Smartphone className="h-4 w-4" aria-hidden />
        Pay {formatMoney(tier.price, currency)} with M-Pesa
      </Button>

      {collapsed ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="w-full"
          onClick={() => setOpen(false)}
        >
          Use my wallet balance instead
        </Button>
      ) : null}
    </form>
  );
}

function TierCard({
  tier,
  currency,
  balance,
  defaultPhone,
  bonusTiers,
  onPurchased,
}: {
  tier: PackageWithUsage;
  currency: string;
  balance: number;
  defaultPhone: string;
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
              {affordable ? (
                <>
                  <Button className="w-full" size="lg" loading={loading} onClick={buy}>
                    <Sparkles className="h-4 w-4" aria-hidden />
                    {`Activate for ${formatMoney(tier.price, currency)}`}
                  </Button>
                  <p className="text-center text-xs text-muted-foreground">
                    Paid from your wallet balance ({formatMoney(balance, currency)} available).
                  </p>
                </>
              ) : null}

              {/*
                M-Pesa, for the buyer whose wallet cannot cover the price — which
                is everyone who has not been paid yet.

                This replaced a disabled button reading "Not enough balance" and a
                line saying how much more was needed. Both were true and neither
                was useful: they named a shortfall and offered no way to close it,
                so the only route to a package ran through the deposit page and a
                second decision. The shortfall is deliberately NOT offered as a
                pay-this-much button — a top-up of the difference is usually below
                the currency's own KES 800 deposit floor, which the server would
                refuse. Paying the package price is the amount that is always valid.
              */}
              <PayByMpesa
                tier={tier}
                currency={currency}
                defaultPhone={defaultPhone}
                onActivated={onPurchased}
                collapsed={affordable}
              />

              {!affordable ? (
                <p className="text-center text-xs text-muted-foreground">
                  Your wallet has {formatMoney(balance, currency)}. Pay the package price directly from
                  M-Pesa and {tier.name} activates itself once the payment clears.
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
  defaultPhone,
  bonusTiers,
}: {
  tiers: PackageWithUsage[];
  currency: string;
  balance: number;
  /** The number on the profile, pre-filled into the M-Pesa prompt — editable. */
  defaultPhone: string;
  bonusTiers: DepositBonusTier[];
}) {
  const router = useRouter();

  /*
    Stable identity, because it is a dependency of the payment component's polling
    effect: a new function every render would tear that interval down before its
    first tick and no payment would ever be seen to complete.
  */
  const refresh = React.useCallback(() => router.refresh(), [router]);

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
          defaultPhone={defaultPhone}
          bonusTiers={bonusTiers}
          onPurchased={refresh}
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
