import type { Metadata } from "next";
import { requireSessionUser } from "@/lib/auth/guards";
import { getWalletOverview } from "@/server/services/wallet";
import { RedeeemCodeForm } from "@/components/app/redeem-code-form";

export const metadata: Metadata = { title: "Redeem Code" };

export default async function RedeemPage() {
  const session = await requireSessionUser();
  const overview = await getWalletOverview(session.profile.id);
  const currency = overview?.wallet.currency ?? "KES";

  return (
    <div className="mx-auto max-w-lg space-y-6 px-4 py-8">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Redeem a Code</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Have a promo code? Paste it below to add money to your wallet.
        </p>
      </div>

      <div className="rounded-2xl border border-border bg-card p-5">
        <RedeeemCodeForm currency={currency} />
      </div>

      <div className="rounded-2xl border border-border bg-card p-5">
        <h2 className="text-sm font-semibold">How it works</h2>
        <ol className="mt-2 space-y-2 text-sm text-muted-foreground">
          <li className="flex gap-2">
            <span className="font-bold text-orangeBrand-500">1.</span>
            Get a redeem code from TaskCash Pro (via events, promotions, or admin).
          </li>
          <li className="flex gap-2">
            <span className="font-bold text-orangeBrand-500">2.</span>
            Paste the code exactly as shown (codes are not case-sensitive).
          </li>
          <li className="flex gap-2">
            <span className="font-bold text-orangeBrand-500">3.</span>
            Click Redeem. The money is added to your available balance instantly.
          </li>
          <li className="flex gap-2">
            <span className="font-bold text-orangeBrand-500">4.</span>
            Each code can only be used a limited number of times. First come, first served.
          </li>
        </ol>
      </div>
    </div>
  );
}
