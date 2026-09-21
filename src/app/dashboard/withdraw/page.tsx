import type { Metadata } from "next";
import { guardVerifiedPage } from "@/lib/auth/guards";
import { getWithdrawalPreview, listUserWithdrawals } from "@/server/services/withdrawals";
import { WithdrawForm } from "@/components/app/withdraw-form";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, Badge, EmptyState, statusBadgeVariant } from "@/components/ui/misc";
import { formatDateTime, formatMoney } from "@/lib/money/format";
import { statusLabel } from "@/lib/types";
import { Banknote } from "lucide-react";

export const metadata: Metadata = { title: "Withdraw" };

export const dynamic = "force-dynamic";

export default async function WithdrawPage() {
  const session = await guardVerifiedPage("/dashboard/withdraw");
  const [preview, withdrawals] = await Promise.all([
    getWithdrawalPreview({ profile: session.profile, wallet: session.wallet }),
    listUserWithdrawals(session.profile.id, 15),
  ]);

  const currency = session.wallet.currency;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Withdraw</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Request a payout to your mobile money number. Every request is reviewed before payment.
        </p>
      </div>

      <Card>
        <CardContent className="grid gap-4 p-5 sm:grid-cols-4">
          <Metric label="Available" value={formatMoney(preview.availableBalance, currency)} />
          <Metric label="Locked" value={formatMoney(preview.lockedBalance, currency)} />
          <Metric label="Minimum" value={formatMoney(preview.minimum, currency)} />
          <Metric
            label="Daily remaining"
            value={formatMoney(preview.dailyRemaining, currency)}
          />
        </CardContent>
      </Card>

      <Alert variant="warning" title="Withdrawals are reviewed by a person">
        <p>
          Withdrawals are reviewed by the TaskCash Pro administration team before payment is sent.
          Requested funds are held in your locked balance during the review, and are returned to your
          available balance if the request is not approved.
        </p>
      </Alert>

      <Card>
        <CardHeader>
          <CardTitle>New withdrawal request</CardTitle>
          <CardDescription>
            Payouts are sent through our payment partner to the number you provide.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <WithdrawForm
            currency={currency}
            availableBalance={preview.availableBalance}
            lockedBalance={preview.lockedBalance}
            defaultPhone={preview.phone}
            minimum={preview.minimum}
            maximum={preview.maximum}
            fee={preview.withdrawalFee}
            dailyRemaining={preview.dailyRemaining}
            requiresKyc={preview.requiresKyc}
            kycStatus={preview.kycStatus}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Your withdrawal requests</CardTitle>
          <CardDescription>Newest first. Statuses reflect real provider outcomes.</CardDescription>
        </CardHeader>
        <CardContent>
          {withdrawals.length === 0 ? (
            <EmptyState
              icon={Banknote}
              title="No withdrawal requests yet"
              description="When you request a payout it will appear here with its review status."
              className="py-8"
            />
          ) : (
            <ul className="divide-y divide-border">
              {withdrawals.map((withdrawal) => (
                <li key={withdrawal.id} className="flex items-start justify-between gap-4 py-3.5">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold tabular-nums">
                      {formatMoney(Number(withdrawal.amount), withdrawal.currency)}
                    </p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {withdrawal.phone} · {formatDateTime(withdrawal.requested_at)}
                    </p>
                    {Number(withdrawal.fee) > 0 ? (
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        Fee {formatMoney(Number(withdrawal.fee), withdrawal.currency)} · you receive{" "}
                        {formatMoney(Number(withdrawal.net_amount), withdrawal.currency)}
                      </p>
                    ) : null}
                    {withdrawal.rejection_reason ? (
                      <p className="mt-1 text-xs text-destructive">
                        {withdrawal.rejection_reason}
                      </p>
                    ) : null}
                    {withdrawal.failure_reason && !withdrawal.rejection_reason ? (
                      <p className="mt-1 text-xs text-destructive">{withdrawal.failure_reason}</p>
                    ) : null}
                  </div>
                  <Badge variant={statusBadgeVariant(withdrawal.status)}>
                    {statusLabel(withdrawal.status)}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <p className="text-xs leading-relaxed text-muted-foreground">
        Expected timing after approval: {preview.processingDays}. Payout completion depends on our
        payment partner, and a withdrawal is only marked completed once the provider confirms it.
      </p>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-1 text-lg font-bold tabular-nums">{value}</p>
    </div>
  );
}
