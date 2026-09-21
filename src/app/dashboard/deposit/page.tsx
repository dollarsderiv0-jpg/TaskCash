import type { Metadata } from "next";
import { guardVerifiedPage } from "@/lib/auth/guards";
import { listUserDeposits } from "@/server/services/deposits";
import { getPublicSettings } from "@/lib/settings";
import { DepositForm } from "@/components/app/deposit-form";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert } from "@/components/ui/misc";
import { formatMoney } from "@/lib/money/format";

export const metadata: Metadata = { title: "Deposit" };

export const dynamic = "force-dynamic";

export default async function DepositPage() {
  const session = await guardVerifiedPage("/dashboard/deposit");
  const [settings, deposits] = await Promise.all([
    getPublicSettings(),
    listUserDeposits(session.profile.id, 15),
  ]);

  const currency = session.wallet.currency;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Deposit</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Add funds to your TaskCash Pro wallet through our payment partner.
        </p>
      </div>

      <Card>
        <CardContent className="grid gap-4 p-5 sm:grid-cols-3">
          <div>
            <p className="text-xs uppercase tracking-wide text-muted-foreground">
              Current balance
            </p>
            <p className="mt-1 text-lg font-bold tabular-nums">
              {formatMoney(Number(session.wallet.available_balance), currency)}
            </p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Minimum deposit</p>
            <p className="mt-1 text-lg font-bold tabular-nums">
              {formatMoney(settings.minDeposit, currency)}
            </p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-wide text-muted-foreground">
              Maximum single deposit
            </p>
            <p className="mt-1 text-lg font-bold tabular-nums">
              {formatMoney(settings.maxDeposit, currency)}
            </p>
          </div>
        </CardContent>
      </Card>

      <Alert variant="info" title="Payments are confirmed by the provider, not the browser">
        <p>
          When you send a payment request, we ask our payment partner to collect the amount. Your
          wallet is credited only after the provider independently confirms the transaction. If a
          payment stays unconfirmed we keep it pending and reconcile it against the provider record —
          we never credit it on assumption.
        </p>
      </Alert>

      <Card>
        <CardHeader>
          <CardTitle>New deposit</CardTitle>
          <CardDescription>
            You will receive an M-Pesa prompt on your phone. Enter your PIN there to approve it.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <DepositForm
            currency={currency}
            defaultPhone={session.profile.phone}
            minAmount={settings.minDeposit}
            maxAmount={settings.maxDeposit}
            recentDeposits={deposits}
          />
        </CardContent>
      </Card>
    </div>
  );
}
