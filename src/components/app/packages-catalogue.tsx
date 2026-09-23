"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  CalendarClock,
  CheckCircle2,
  ChevronDown,
  Clock,
  Lock,
  PlayCircle,
  RefreshCw,
  ShieldCheck,
  Smartphone,
  Sparkles,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, Input } from "@/components/ui/fields";
import { Alert, Badge, EmptyState, Progress } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { apiRequest, newIdempotencyKey } from "@/lib/client/api";
import { useCountdown } from "@/lib/client/use-countdown";
import { normalisePhone } from "@/lib/countries";
import { formatMoney } from "@/lib/money/format";
import type { CataloguePackage } from "@/server/services/packages";

/**
 * The package catalogue for Watch & Earn.
 *
 * WHAT THIS COMPONENT IS ALLOWED TO DECIDE, AND WHAT IT IS NOT
 * -----------------------------------------------------------
 * Every figure on a card — the price, the daily ceiling, the total ceiling, the
 * term, each video's reward — is read from the server render. A purchase ends
 * with `router.refresh()` and the numbers are re-read; there is no optimistic
 * balance and no locally incremented total anywhere in this file.
 *
 * The countdown is the one thing computed here, and it is presentation only. The
 * allowance that actually gates a reward is computed in the database against the
 * operator's midnight, so a device clock that is wrong, paused or throttled
 * cannot buy the user a single extra shilling. Expiry is likewise decided on the
 * server (`tier.expired`) rather than by comparing `expiresAt` to this device's
 * idea of now.
 *
 * A successful payment request means an STK prompt was SENT, and nothing more.
 * The package is called active only when the server reports that the provider
 * confirmed the payment AND that the activation happened.
 */

/** How many of a package's videos a card lists before offering the rest. */
const VISIBLE_VIDEOS = 5;

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

/** The state a card is in, as one value rather than three booleans. */
function packageState(tier: CataloguePackage): "active" | "expired" | "available" | "unavailable" {
  if (tier.daily_earning_cap <= 0) return "unavailable";
  if (!tier.owned) return "available";
  return tier.expired ? "expired" : "active";
}

/**
 * One video and what this package pays for it.
 *
 * The rate is per video and per package (migration 0020): the same video can pay
 * 10 under one tier and 30 under another, so a "reward" column is the only
 * honest way to show it. A single "up to X per video" figure would be a claim
 * about an average that no row in the database supports.
 */
function VideoRow({
  index,
  title,
  rewardAmount,
  currency,
}: {
  index: number;
  title: string;
  rewardAmount: number;
  currency: string;
}) {
  return (
    <li className="flex items-center gap-2 py-1.5">
      <span className="w-4 shrink-0 text-[11px] font-semibold tabular-nums text-muted-foreground">
        {index}
      </span>
      <span className="min-w-0 flex-1 truncate text-xs" title={title}>
        {title}
      </span>
      <span className="shrink-0 text-xs font-semibold tabular-nums">
        {formatMoney(rewardAmount, currency, { decimals: 0 })}
      </span>
    </li>
  );
}

/**
 * Pay for a package by M-Pesa.
 *
 * Three steps, and the middle one is not decoration. The buyer types a number,
 * then sees exactly what will be charged and where it will be sent, and only
 * then does anything leave their account. Money requests that appear on a phone
 * with no preceding confirmation are how people are persuaded to approve a
 * payment they did not intend, so the confirmation states the amount and the
 * number together, in one place, before the prompt is raised.
 *
 * The prompt is then polled rather than trusted: the dialog waits for the
 * provider's confirmation, because the only thing this component knows after a
 * successful request is that a prompt was sent.
 */
function PackagePurchaseDialog({
  tier,
  currency,
  balance,
  defaultPhone,
  country,
  open,
  onOpenChange,
  onActivated,
}: {
  tier: CataloguePackage;
  currency: string;
  balance: number;
  defaultPhone: string;
  country: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onActivated: () => void;
}) {
  const { toast } = useToast();
  const [step, setStep] = React.useState<"phone" | "confirm" | "pending">("phone");
  const [phone, setPhone] = React.useState(defaultPhone);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [checking, setChecking] = React.useState(false);
  const [pending, setPending] = React.useState<PackagePaymentResult | null>(null);

  const price = formatMoney(tier.price, currency);
  const affordable = balance >= tier.price;

  // Each time the dialog opens it starts from the first step, so a buyer who
  // closed it mid-payment is not dropped back into a stale confirmation for a
  // number they have since changed.
  React.useEffect(() => {
    if (!open) return;
    setStep("phone");
    setError(null);
    setPending(null);
  }, [open]);

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
        onOpenChange(false);
        // The authoritative balance, allowance and video list all come from the
        // server after this; nothing is adjusted locally.
        onActivated();
        return;
      }

      toast({
        title:
          result.status === "PENDING" ? "Still waiting on the provider" : "Payment not completed",
        description: result.message,
        tone: result.status === "PENDING" ? "info" : "warning",
      });

      // A terminal outcome ends the prompt. PENDING keeps it on screen so the
      // buyer can approve late instead of raising a second prompt.
      if (result.status !== "PENDING") setPending(null);
    },
    [onActivated, onOpenChange, toast],
  );

  /*
    Poll while a prompt is open. Confirmation usually lands within seconds of the
    buyer entering their PIN, and the alternative is a screen that says nothing.

    Bounded to 15 attempts at 6 seconds, comfortably inside the verify endpoint's
    allowance, so a prompt that is never answered costs a handful of requests
    rather than a rate limit. The interval reads `pending.depositId` and not any
    other state, so it cannot be torn down and re-created before its first tick.
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

  /** Raises the prompt. Runs only from the confirmation step. */
  async function pay() {
    setError(null);
    setLoading(true);

    const response = await apiRequest<PackagePaymentResult>("/api/deposits/create", {
      method: "POST",
      body: {
        packageId: tier.id,
        // Sent for shape only: the server charges the package row's own price and
        // ignores anything here, which is what stops a client picking its price.
        amount: tier.price,
        phone: phone.trim(),
        idempotencyKey: newIdempotencyKey("package-payment"),
        acceptTerms: true,
      },
    });

    setLoading(false);

    if (!response.ok) {
      setError(response.message);
      setStep("phone");
      return;
    }

    setPending(response.data);
    setStep("pending");
    toast({
      title: "Check your phone and enter your M-Pesa PIN",
      description:
        `Approve ${formatMoney(response.data.amount, response.data.currency)} sent to ` +
        `${response.data.phone}. ${tier.name} activates as soon as the payment is confirmed.`,
      tone: "info",
    });
  }

  /** Buys out of the wallet balance instead. The other real payment path. */
  async function payFromWallet() {
    setError(null);
    setLoading(true);

    const response = await apiRequest<{ message: string }>("/api/packages/purchase", {
      method: "POST",
      body: { packageId: tier.id },
    });

    setLoading(false);

    if (!response.ok) {
      setError(response.message);
      return;
    }

    toast({ title: response.data.message, tone: "success" });
    onOpenChange(false);
    onActivated();
  }

  function toConfirm(event: React.FormEvent) {
    event.preventDefault();
    setError(null);

    /*
      Validated with the same function the server settles with, against the same
      country, so a number this dialog accepts is a number the deposit service
      will accept — rather than a looser check here and a rejection later.
    */
    const normalised = normalisePhone(phone, country || "KE");
    if (!normalised.ok) {
      setError(normalised.reason);
      return;
    }

    setPhone(normalised.e164.replace(/^\+/, ""));
    setStep("confirm");
  }

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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Buy {tier.name}</DialogTitle>
          <DialogDescription>
            {step === "pending"
              ? "Waiting for the payment provider to confirm."
              : "Paid from M-Pesa. The package activates only after the provider confirms your payment."}
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-baseline justify-between rounded-xl border border-border px-4 py-3">
          <span className="text-xs uppercase tracking-wide text-muted-foreground">
            Package price
          </span>
          <span className="text-lg font-bold tabular-nums">{price}</span>
        </div>

        {error ? (
          <p className="text-xs font-medium text-destructive" role="alert">
            {error}
          </p>
        ) : null}

        {step === "phone" ? (
          <form onSubmit={toConfirm} className="space-y-4" noValidate>
            <Field label="M-Pesa phone number" htmlFor={`mpesa-phone-${tier.id}`}>
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

            <Button type="submit" className="w-full" size="lg">
              <Smartphone className="h-4 w-4" aria-hidden />
              Confirm &amp; Pay
            </Button>

            {affordable ? (
              <button
                type="button"
                onClick={payFromWallet}
                disabled={loading}
                className="w-full text-center text-xs text-muted-foreground underline-offset-4 hover:underline disabled:opacity-50"
              >
                Or pay {formatMoney(tier.price, currency)} from your wallet balance
              </button>
            ) : null}
          </form>
        ) : null}

        {step === "confirm" ? (
          <div className="space-y-4">
            <Alert variant="warning" title="Confirm this payment">
              <p>
                You are about to pay <strong>{price}</strong> using M-Pesa.
              </p>
              <p className="mt-2">
                Phone number: <strong className="tabular-nums">{phone}</strong>
              </p>
              <p className="mt-2 text-xs">
                {tier.name} activates only once the provider confirms the payment. If it is
                cancelled, fails or is left pending, nothing is charged and the package stays
                inactive.
              </p>
            </Alert>

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setStep("phone")}
                disabled={loading}
              >
                Cancel
              </Button>
              <Button type="button" onClick={pay} loading={loading} size="lg">
                <ShieldCheck className="h-4 w-4" aria-hidden />
                Confirm &amp; Pay
              </Button>
            </DialogFooter>
          </div>
        ) : null}

        {step === "pending" && pending ? (
          <div className="space-y-4">
            <Alert variant="info" title="Check your phone and enter your M-Pesa PIN">
              <p>
                A payment prompt for {formatMoney(pending.amount, pending.currency)} was sent to{" "}
                {pending.phone}. This dialog checks by itself — you do not need to refresh.
              </p>
              <p className="mt-2 font-mono text-[11px]">Reference {pending.merchantReference}</p>
            </Alert>

            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                onClick={() => onOpenChange(false)}
                disabled={checking}
              >
                Close
              </Button>
              <Button
                type="button"
                onClick={() => verify(pending.depositId)}
                loading={checking}
                size="lg"
              >
                <RefreshCw className="h-4 w-4" aria-hidden />
                I have paid — check now
              </Button>
            </DialogFooter>
          </div>
        ) : null}

        <p className="text-[11px] leading-relaxed text-muted-foreground">
          Earnings come from the campaigns behind each video and depend on their remaining
          budgets. The daily and total figures are ceilings, not promised returns.
        </p>
      </DialogContent>
    </Dialog>
  );
}

/** One package, as a card. Every figure on it came from the server render. */
function PackageCard({
  tier,
  currency,
  balance,
  defaultPhone,
  country,
  onChanged,
}: {
  tier: CataloguePackage;
  currency: string;
  balance: number;
  defaultPhone: string;
  country: string;
  onChanged: () => void;
}) {
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [showAllVideos, setShowAllVideos] = React.useState(false);
  const countdown = useCountdown(tier.resetsAt);

  const state = packageState(tier);
  const videos = tier.videos;
  const listed = showAllVideos ? videos : videos.slice(0, VISIBLE_VIDEOS);
  const hidden = videos.length - listed.length;

  const spent = Math.max(0, tier.daily_earning_cap - tier.remainingToday);
  const percent =
    tier.daily_earning_cap > 0 ? Math.min(100, (spent / tier.daily_earning_cap) * 100) : 0;

  const daysLeft =
    tier.expiresAt && !tier.expired
      ? Math.max(
          0,
          Math.ceil((new Date(tier.expiresAt).getTime() - Date.now()) / (24 * 60 * 60 * 1000)),
        )
      : null;

  return (
    <Card className="flex flex-col overflow-hidden">
      {/* Header: what it is, and whether you hold it. */}
      <div className="flex items-start justify-between gap-3 border-b border-border bg-secondary/30 px-5 py-4">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-bold uppercase tracking-wide">{tier.name}</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {videos.length > 0
              ? `${videos.length} video${videos.length === 1 ? "" : "s"}`
              : "Videos being added"}
            {tier.duration_days ? ` · ${tier.duration_days} days` : ""}
          </p>
        </div>
        {state === "active" ? (
          <Badge variant="success">
            <CheckCircle2 className="h-3 w-3" aria-hidden />
            Active
          </Badge>
        ) : state === "expired" ? (
          <Badge variant="warning">
            <CalendarClock className="h-3 w-3" aria-hidden />
            Expired
          </Badge>
        ) : (
          <Badge variant="outline">Not active</Badge>
        )}
      </div>

      <CardContent className="flex flex-1 flex-col gap-4 p-5">
        {/* Price, and the term it buys. */}
        <div className="flex items-end justify-between gap-3">
          <div>
            <p className="text-3xl font-bold tracking-tight tabular-nums">
              {formatMoney(tier.price, currency, { decimals: 0 })}
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {tier.duration_days
                ? `one-off, earnable for ${tier.duration_days} days`
                : "one-off, no expiry"}
            </p>
          </div>
          {state === "active" && daysLeft !== null ? (
            <p className="shrink-0 text-right text-xs text-muted-foreground">
              <span className="block font-semibold text-foreground">{daysLeft}</span>
              day{daysLeft === 1 ? "" : "s"} remaining
            </p>
          ) : null}
        </div>

        {/* The ceilings, side by side. Small, labelled, and the same two facts a
            buyer compares across tiers. */}
        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-xl border border-border px-3 py-2">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
              Maximum daily
            </p>
            <p className="mt-0.5 text-sm font-bold tabular-nums">
              {formatMoney(tier.daily_earning_cap, currency, { decimals: 0 })}
            </p>
          </div>
          <div className="rounded-xl border border-border px-3 py-2">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
              Maximum total
            </p>
            <p className="mt-0.5 text-sm font-bold tabular-nums">
              {tier.lifetime_earning_cap
                ? formatMoney(tier.lifetime_earning_cap, currency, { decimals: 0 })
                : "No ceiling"}
            </p>
          </div>
        </div>

        {/* What you are actually buying: the videos, each with its own reward. */}
        {videos.length > 0 ? (
          <div className="rounded-xl border border-border">
            <div className="flex items-center justify-between border-b border-border px-3 py-2">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Videos and rewards
              </p>
              <p className="text-[10px] tabular-nums text-muted-foreground">{videos.length}</p>
            </div>
            <ul className="divide-y divide-border px-3 py-1">
              {listed.map((video, index) => (
                <VideoRow
                  key={video.id}
                  index={index + 1}
                  title={video.title}
                  rewardAmount={video.rewardAmount}
                  currency={currency}
                />
              ))}
            </ul>
            {hidden > 0 || showAllVideos ? (
              <button
                type="button"
                onClick={() => setShowAllVideos((current) => !current)}
                className="flex w-full items-center justify-center gap-1 border-t border-border py-2 text-[11px] font-semibold text-muted-foreground hover:bg-secondary/50"
              >
                <ChevronDown
                  className={
                    showAllVideos ? "h-3 w-3 rotate-180 transition-transform" : "h-3 w-3 transition-transform"
                  }
                  aria-hidden
                />
                {showAllVideos ? "Show fewer" : `Show ${hidden} more`}
              </button>
            ) : null}
          </div>
        ) : null}

        {/* An owned package reports today's usage against the real allowance. */}
        {state === "active" ? (
          <div>
            <div className="flex items-baseline justify-between gap-2">
              <p className="text-xs text-muted-foreground">Earned today</p>
              <p className="text-xs font-semibold tabular-nums">
                {formatMoney(tier.earnedToday, currency, { decimals: 0 })}
                <span className="font-normal text-muted-foreground">
                  {" "}
                  of {formatMoney(tier.daily_earning_cap, currency, { decimals: 0 })}
                </span>
              </p>
            </div>
            <Progress
              className="mt-1.5"
              value={percent}
              label={`${tier.name} allowance used: ${Math.round(percent)}%`}
            />
            {countdown ? (
              <p className="mt-1.5 flex items-center gap-1 text-[11px] text-muted-foreground">
                <Clock className="h-3 w-3" aria-hidden />
                Allowance resets in {countdown}
              </p>
            ) : null}
          </div>
        ) : null}

        {state === "expired" ? (
          <p className="rounded-xl border border-dashed border-border p-3 text-[11px] leading-relaxed text-muted-foreground">
            This package&apos;s earning period has ended, so its videos no longer pay. Activating it
            again starts a new period and a new allowance.
          </p>
        ) : null}

        <p className="text-[11px] leading-relaxed text-muted-foreground">
          Ceilings, not promises — each reward is paid only while its campaign still has budget. No
          guaranteed returns.
        </p>

        <div className="mt-auto space-y-2">
          {state === "unavailable" ? (
            <Alert variant="warning" title="Not on sale yet">
              <p>
                This package is still being set up. Its daily earning limit has not been published
                yet, so it cannot be activated.
              </p>
            </Alert>
          ) : state === "active" ? (
            <Button asChild className="w-full" size="lg">
              <Link href={`/dashboard/watch?package=${tier.id}`}>
                <PlayCircle className="h-4 w-4" aria-hidden />
                WATCH
              </Link>
            </Button>
          ) : (
            <>
              <Button className="w-full" size="lg" onClick={() => setDialogOpen(true)}>
                <Sparkles className="h-4 w-4" aria-hidden />
                BUY
              </Button>
              {balance < tier.price ? (
                <p className="text-center text-[11px] text-muted-foreground">
                  Pay the package price directly from M-Pesa — {tier.name} activates itself once the
                  payment clears.
                </p>
              ) : (
                <p className="text-center text-[11px] text-muted-foreground">
                  {formatMoney(balance, currency, { decimals: 0 })} available in your wallet.
                </p>
              )}
            </>
          )}
        </div>
      </CardContent>

      <PackagePurchaseDialog
        tier={tier}
        currency={currency}
        balance={balance}
        defaultPhone={defaultPhone}
        country={country}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onActivated={onChanged}
      />
    </Card>
  );
}

export function PackagesCatalogue({
  tiers,
  currency,
  balance,
  defaultPhone,
  country,
}: {
  tiers: CataloguePackage[];
  currency: string;
  balance: number;
  /** The number on the profile, pre-filled into the prompt — editable. */
  defaultPhone: string;
  country: string;
}) {
  const router = useRouter();

  /*
    Stable identity, because it is a dependency of the payment dialog's polling
    effect: a new function every render would tear that interval down before its
    first tick and no payment would ever be seen to complete.
  */
  const refresh = React.useCallback(() => router.refresh(), [router]);

  if (tiers.length === 0) {
    return (
      <EmptyState
        icon={PlayCircle}
        title="No packages available right now"
        description="Packages appear here as soon as an administrator publishes them."
      />
    );
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {tiers.map((tier) => (
        <PackageCard
          key={tier.id}
          tier={tier}
          currency={currency}
          balance={balance}
          defaultPhone={defaultPhone}
          country={country}
          onChanged={refresh}
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
