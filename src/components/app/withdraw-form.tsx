"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Info, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox, Field, Input } from "@/components/ui/fields";
import { Alert, Separator } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { apiRequest, newIdempotencyKey } from "@/lib/client/api";
import { formatMoney } from "@/lib/money/format";
import { statusLabel } from "@/lib/types";

type WithdrawalResult = {
  withdrawalId: string;
  amount: number;
  fee: number;
  netAmount: number;
  currency: string;
  phone: string;
  status: string;
  message: string;
  availableBalance: number | null;
  lockedBalance: number | null;
  note: string;
};

/**
 * Withdrawal request form.
 *
 * Submitting this does NOT send money. It reserves the amount (available ->
 * locked) and creates a request for administrator review. All eligibility
 * rules are enforced by the database function, and its error messages are
 * surfaced verbatim because they are already written for users.
 */
export function WithdrawForm({
  currency,
  availableBalance,
  lockedBalance,
  defaultPhone,
  minimum,
  maximum,
  fee,
  dailyRemaining,
  requiresKyc,
  kycStatus,
}: {
  currency: string;
  availableBalance: number;
  lockedBalance: number;
  defaultPhone: string;
  minimum: number;
  maximum: number;
  fee: number;
  dailyRemaining: number;
  requiresKyc: boolean;
  kycStatus: string;
}) {
  const router = useRouter();
  const { toast } = useToast();

  const [amount, setAmount] = React.useState("");
  const [phone, setPhone] = React.useState(defaultPhone);
  const [confirmed, setConfirmed] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [formError, setFormError] = React.useState<string | null>(null);
  const [submitted, setSubmitted] = React.useState<WithdrawalResult | null>(null);

  const numericAmount = Number(amount);
  const amountValid = Number.isFinite(numericAmount) && numericAmount > 0;
  const effectiveFee = fee > 0 ? Math.min(fee, Math.max(0, numericAmount || 0)) : 0;
  const netAmount = amountValid ? Math.max(0, numericAmount - effectiveFee) : 0;

  const kycBlocked = requiresKyc && kycStatus !== "VERIFIED";
  const nothingAvailable = availableBalance < minimum;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setErrors({});
    setFormError(null);

    const nextErrors: Record<string, string> = {};
    if (!amountValid) nextErrors.amount = "Enter a valid amount.";
    else if (numericAmount < minimum) nextErrors.amount = `Minimum is ${formatMoney(minimum, currency)}.`;
    else if (numericAmount > maximum) nextErrors.amount = `Maximum is ${formatMoney(maximum, currency)}.`;
    else if (numericAmount > availableBalance)
      nextErrors.amount = `You only have ${formatMoney(availableBalance, currency)} available.`;
    else if (numericAmount > dailyRemaining)
      nextErrors.amount = `This exceeds your remaining 24-hour limit of ${formatMoney(dailyRemaining, currency)}.`;
    if (phone.trim().length < 7) nextErrors.phone = "Enter the mobile money number to pay out to.";
    if (!confirmed) nextErrors.confirmed = "Please confirm the withdrawal details.";

    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;

    setLoading(true);

    const response = await apiRequest<WithdrawalResult>("/api/withdrawals/create", {
      method: "POST",
      body: {
        amount: numericAmount,
        phone: phone.trim(),
        idempotencyKey: newIdempotencyKey("withdrawal"),
        confirm: true,
      },
    });

    setLoading(false);

    if (!response.ok) {
      setErrors(response.fields ?? {});
      setFormError(response.message);
      return;
    }

    setSubmitted(response.data);
    setAmount("");
    setConfirmed(false);
    toast({
      title: "Withdrawal request submitted",
      description: "It is now pending our administration team's review.",
      tone: "success",
    });
    router.refresh();
  }

  if (submitted) {
    return (
      <div className="space-y-5">
        <Alert variant="success" title="Withdrawal request submitted">
          <div className="space-y-2">
            <p>{submitted.message}</p>
            {/*
              The server returns the raw status code. A first-time user should
              never read "PENDING ADMIN APPROVAL" — that is our vocabulary, not
              theirs. The shared label map turns it into the same words the rest
              of the app uses.
            */}
            <p className="font-semibold text-foreground">
              Status: {statusLabel(submitted.status)}
            </p>
            <ul className="mt-2 space-y-1 text-xs">
              <li>Amount requested: {formatMoney(submitted.amount, submitted.currency)}</li>
              {submitted.fee > 0 ? (
                <li>Fee: {formatMoney(submitted.fee, submitted.currency)}</li>
              ) : null}
              <li>You receive: {formatMoney(submitted.netAmount, submitted.currency)}</li>
              <li>Destination: {submitted.phone}</li>
            </ul>
            {submitted.lockedBalance !== null ? (
              <p className="mt-2 text-xs">
                Locked balance is now {formatMoney(submitted.lockedBalance, submitted.currency)}.
              </p>
            ) : null}
          </div>
        </Alert>

        <p className="text-sm text-muted-foreground">
          Our team reviews every request before any money is sent, so it will not arrive instantly.
          You will get a notification the moment the status changes — there is nothing else you need
          to do.
        </p>

        <div className="flex flex-col gap-3 sm:flex-row">
          <Button onClick={() => setSubmitted(null)}>Request another withdrawal</Button>
          <Button variant="outline" onClick={() => router.push("/dashboard/wallet")}>
            View wallet
          </Button>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-5" noValidate>
      {formError ? (
        <Alert variant="destructive" title="Withdrawal not submitted">
          <p>{formError}</p>
        </Alert>
      ) : null}

      {kycBlocked ? (
        <Alert variant="warning" title="Verification required">
          <p>
            Withdrawals currently require a verified account. Your verification status is{" "}
            <strong>{statusLabel(kycStatus).toLowerCase()}</strong>. Please contact support to
            complete verification.
          </p>
        </Alert>
      ) : null}

      {nothingAvailable ? (
        <Alert variant="info" title="Not enough available balance yet">
          <p>
            Your balance is below the amount needed to request a withdrawal. Keep completing
            eligible campaigns and your balance will build up.
          </p>
        </Alert>
      ) : null}

      {/*
        The minimum is deliberately not printed here — the platform's amounts are
        shown on the wallet screen inside the app. The field still enforces it, and
        an amount below it is refused with a message that names the figure.
      */}
      <Field label={`Amount (${currency})`} htmlFor="amount" error={errors.amount}>
        <Input
          id="amount"
          type="number"
          inputMode="decimal"
          min={minimum}
          max={Math.min(maximum, availableBalance)}
          step="1"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          aria-invalid={Boolean(errors.amount)}
        />
      </Field>

      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={availableBalance <= 0}
          onClick={() => setAmount(String(Math.floor(availableBalance)))}
        >
          All available
        </Button>
      </div>

      <Field
        label="Mobile money number"
        htmlFor="phone"
        error={errors.phone}
        hint="Payouts are sent to this number. Make sure it is registered in your own name."
      >
        <Input
          id="phone"
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          aria-invalid={Boolean(errors.phone)}
        />
      </Field>

      <Separator />

      <dl className="space-y-2 text-sm">
        <SummaryRow label="Withdrawal amount" value={amountValid ? formatMoney(numericAmount, currency) : "—"} />
        <SummaryRow label="Fee" value={formatMoney(effectiveFee, currency)} />
        <SummaryRow
          label="You receive"
          value={amountValid ? formatMoney(netAmount, currency) : "—"}
          emphasis
        />
      </dl>

      <div className="space-y-2">
        <label className="flex items-start gap-3 text-sm">
          <Checkbox
            checked={confirmed}
            onCheckedChange={(checked) => setConfirmed(checked === true)}
            className="mt-0.5"
            aria-invalid={Boolean(errors.confirmed)}
          />
          <span className="leading-relaxed text-muted-foreground">
            I confirm the amount and mobile money number above. I understand the requested amount
            will be held (moved to locked) while the request is reviewed, and that payment is sent
            only after an administrator approves it. If the request is rejected or the payout fails,
            the held funds return to my available balance.
          </span>
        </label>
        {errors.confirmed ? (
          <p className="text-xs font-medium text-destructive" role="alert">
            {errors.confirmed}
          </p>
        ) : null}
      </div>

      <Alert variant="info" title="Review takes time">
        <p>
          Every withdrawal is checked by a person before it is paid. That is deliberate — it is how
          duplicate requests, compromised accounts and fraudulent payouts are caught. Read our{" "}
          <Link className="underline underline-offset-2" href="/withdrawal-policy">
            withdrawal policy
          </Link>
          .
        </p>
      </Alert>

      <Button
        type="submit"
        size="lg"
        className="w-full"
        loading={loading}
        disabled={kycBlocked || nothingAvailable}
      >
        <Send className="h-4 w-4" aria-hidden />
        Request withdrawal
      </Button>

      {/*
        "Nothing is sent to the provider at this point" is an implementation
        detail. What the user actually needs to know is where their money is
        while they wait, and that nothing has left the platform yet.
      */}
      <p className="flex items-start gap-2 text-xs text-muted-foreground">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
        Submitting moves this amount out of your available balance into locked — it stays yours and
        no money leaves TaskCash Pro until a person approves the request. Already locked:{" "}
        {formatMoney(lockedBalance, currency)}.
      </p>
    </form>
  );
}

function SummaryRow({
  label,
  value,
  emphasis = false,
}: {
  label: string;
  value: string;
  emphasis?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={emphasis ? "text-base font-bold tabular-nums" : "font-semibold tabular-nums"}>
        {value}
      </dd>
    </div>
  );
}
