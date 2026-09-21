"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CheckCircle2, RefreshCw, Smartphone } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox, Field, Input } from "@/components/ui/fields";
import { Alert, Badge, Separator, statusBadgeVariant } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { apiRequest, newIdempotencyKey } from "@/lib/client/api";
import { formatDateTime, formatMoney } from "@/lib/money/format";
import { statusLabel, type Deposit } from "@/lib/types";

type DepositResult = {
  depositId: string;
  merchantReference: string;
  amount: number;
  currency: string;
  phone: string;
  status: string;
  message: string;
  availableBalance: number | null;
  note: string;
};

/**
 * Deposit flow.
 *
 * The UI never claims a payment succeeded. After the provider request is
 * created, the only truthful states are "waiting for confirmation" and the
 * result of an explicit verification call — which credits the wallet only when
 * the provider independently confirms the payment.
 */
export function DepositForm({
  currency,
  defaultPhone,
  minAmount,
  maxAmount,
  recentDeposits,
}: {
  currency: string;
  defaultPhone: string;
  minAmount: number;
  maxAmount: number;
  recentDeposits: Deposit[];
}) {
  const router = useRouter();
  const { toast } = useToast();

  const [amount, setAmount] = React.useState(String(minAmount));
  const [phone, setPhone] = React.useState(defaultPhone);
  const [authorised, setAuthorised] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [verifying, setVerifying] = React.useState<string | null>(null);
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [formError, setFormError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState<DepositResult | null>(null);

  const numericAmount = Number(amount);
  const amountValid = Number.isFinite(numericAmount) && numericAmount > 0;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setErrors({});
    setFormError(null);

    const nextErrors: Record<string, string> = {};
    if (!amountValid) nextErrors.amount = "Enter a valid amount.";
    else if (numericAmount < minAmount) nextErrors.amount = `Minimum is ${formatMoney(minAmount, currency)}.`;
    else if (numericAmount > maxAmount) nextErrors.amount = `Maximum is ${formatMoney(maxAmount, currency)}.`;
    if (phone.trim().length < 7) nextErrors.phone = "Enter the mobile money number to charge.";
    if (!authorised) nextErrors.authorised = "Please confirm you authorise this payment.";

    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;

    setLoading(true);

    const response = await apiRequest<DepositResult>("/api/deposits/create", {
      method: "POST",
      // The idempotency key is generated once per submit, so a double-tap or a
      // retry cannot create two payment requests.
      body: {
        amount: numericAmount,
        phone: phone.trim(),
        idempotencyKey: newIdempotencyKey("deposit"),
        acceptTerms: true,
      },
    });

    setLoading(false);

    if (!response.ok) {
      setErrors(response.fields ?? {});
      setFormError(response.message);
      return;
    }

    setPending(response.data);
    setAuthorised(false);
    toast({
      title: "Check your phone and enter your M-Pesa PIN",
      description: `Approve the prompt for ${formatMoney(response.data.amount, response.data.currency)} ` +
        "sent to " + response.data.phone + ", then confirm below.",
      tone: "info",
    });
    router.refresh();
  }

  async function verify(depositId: string) {
    setVerifying(depositId);
    const response = await apiRequest<{
      status: string;
      credited: boolean;
      duplicate: boolean;
      amount: number;
      currency: string;
      message: string;
      availableBalance: number | null;
    }>("/api/deposits/verify", { method: "POST", body: { depositId } });

    setVerifying(null);

    if (!response.ok) {
      toast({ title: "Could not verify yet", description: response.message, tone: "warning" });
      return;
    }

    toast({
      title:
        response.data.status === "COMPLETED"
          ? "Deposit confirmed"
          : response.data.status === "PENDING"
            ? "Still waiting on the provider"
            : "Deposit not completed",
      description: response.data.message,
      tone:
        response.data.status === "COMPLETED"
          ? "success"
          : response.data.status === "PENDING"
            ? "info"
            : "warning",
    });

    setPending(null);
    router.refresh();
  }

  return (
    <div className="space-y-6">
      {pending ? (
        <Alert variant="info" title="Check your phone and enter your M-Pesa PIN">
          <div className="space-y-3">
            <p>
              A payment prompt for {formatMoney(pending.amount, pending.currency)} was sent to{" "}
              {pending.phone}. Open it and enter your M-Pesa PIN to approve the payment. Your wallet is{" "}
              <strong>not</strong> credited until the provider confirms the payment.
            </p>
            <p className="font-mono text-[11px]">Reference {pending.merchantReference}</p>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                onClick={() => verify(pending.depositId)}
                loading={verifying === pending.depositId}
              >
                <RefreshCw className="h-4 w-4" aria-hidden />
                I have paid — check now
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setPending(null)}>
                Done
              </Button>
            </div>
          </div>
        </Alert>
      ) : null}

      <form onSubmit={submit} className="space-y-5" noValidate>
        {formError ? (
          <Alert variant="destructive" title="Deposit not created">
            <p>{formError}</p>
          </Alert>
        ) : null}

        {/*
          No minimum/maximum hint: the platform's amounts are not published on the
          website. The field still enforces them — `min`/`max` below and the
          server's own check — and a value outside the bounds answers with a
          precise message naming the limit, which is the only place it appears.
        */}
        <Field label={`Amount (${currency})`} htmlFor="amount" error={errors.amount}>
          <Input
            id="amount"
            type="number"
            inputMode="decimal"
            min={minAmount}
            max={maxAmount}
            step="1"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            aria-invalid={Boolean(errors.amount)}
          />
        </Field>

        <div className="flex flex-wrap gap-2">
          {[minAmount, 500, 1000, 2000, 5000]
            .filter((value, index, list) => value <= maxAmount && list.indexOf(value) === index)
            .map((value) => (
              <Button
                key={value}
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setAmount(String(value))}
              >
                {formatMoney(value, currency)}
              </Button>
            ))}
        </div>

        <Field
          label="Mobile money number"
          htmlFor="phone"
          error={errors.phone}
          hint="The number that will receive the payment prompt. Use a number registered in your own name."
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

        <div className="space-y-2">
          <label className="flex items-start gap-3 text-sm">
            <Checkbox
              checked={authorised}
              onCheckedChange={(checked) => setAuthorised(checked === true)}
              className="mt-0.5"
              aria-invalid={Boolean(errors.authorised)}
            />
            <span className="leading-relaxed text-muted-foreground">
              I authorise a payment of{" "}
              <strong className="text-foreground">
                {amountValid ? formatMoney(numericAmount, currency) : "the amount above"}
              </strong>{" "}
              to be collected from my mobile money account via our payment partner. I understand this
              is a payment for platform services and is not an investment.
            </span>
          </label>
          {errors.authorised ? (
            <p className="text-xs font-medium text-destructive" role="alert">
              {errors.authorised}
            </p>
          ) : null}
        </div>

        <Alert variant="warning" title="No guaranteed returns">
          <p>
            A deposit does not produce a guaranteed daily or monthly payout. Rewards depend on
            completing eligible campaigns and on campaign budgets. See our{" "}
            <Link className="underline underline-offset-2" href="/responsible-use">
              financial notice
            </Link>
            .
          </p>
        </Alert>

        {/*
          "Pay with M-Pesa" rather than a provider name: every collection provider
          this product supports (Daraja, SasaPay, PayHero) collects through a
          Safaricom M-Pesa STK push, so the prompt the customer gets is M-Pesa in
          all three cases. The provider is an implementation detail of ours, not
          something the customer acts on.
        */}
        <Button type="submit" size="lg" className="w-full" loading={loading}>
          <Smartphone className="h-4 w-4" aria-hidden />
          Pay with M-Pesa
        </Button>
      </form>

      <Separator />

      <section>
        <h2 className="text-sm font-semibold">Deposit history</h2>
        {recentDeposits.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">
            No deposits yet. Any payment you start will appear here with its real status.
          </p>
        ) : (
          <ul className="mt-3 divide-y divide-border">
            {recentDeposits.map((deposit) => (
              <li key={deposit.id} className="flex items-center justify-between gap-4 py-3">
                <div className="min-w-0">
                  <p className="text-sm font-semibold tabular-nums">
                    {formatMoney(Number(deposit.amount), deposit.currency)}
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {formatDateTime(deposit.created_at)} · {deposit.phone}
                  </p>
                  <p className="mt-0.5 font-mono text-[11px] text-muted-foreground">
                    {deposit.merchant_reference}
                  </p>
                  {deposit.failure_reason ? (
                    <p className="mt-1 text-xs text-destructive">{deposit.failure_reason}</p>
                  ) : null}
                </div>
                <div className="flex shrink-0 flex-col items-end gap-2">
                  <Badge variant={statusBadgeVariant(deposit.status)}>
                    {statusLabel(deposit.status)}
                  </Badge>
                  {["PENDING", "PROCESSING"].includes(deposit.status) ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => verify(deposit.id)}
                      loading={verifying === deposit.id}
                    >
                      Check
                    </Button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <CheckCircle2 className="h-3.5 w-3.5 text-emeraldBrand-500" aria-hidden />
        Deposits are only ever credited after the provider confirms the transaction.
      </p>
    </div>
  );
}
