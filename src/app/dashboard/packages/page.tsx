import type { Metadata } from "next";
import { Package as PackageIcon } from "lucide-react";
import { guardVerifiedPage } from "@/lib/auth/guards";
import { listDepositBonusTiers, listPackageCatalogue } from "@/server/services/packages";
import { PackagesCatalogue, PackagesUnavailable } from "@/components/app/packages-catalogue";
import { Alert } from "@/components/ui/misc";
import { formatMoney } from "@/lib/money/format";

export const metadata: Metadata = { title: "Packages" };
export const dynamic = "force-dynamic";

export default async function PackagesPage() {
  const session = await guardVerifiedPage("/dashboard/packages");
  const [{ packages: tiers, available }, bonusTiers] = await Promise.all([
    listPackageCatalogue(session.profile.id),
    /*
      Read from the setting the settlement function reads, so the bonus shown here
      is the bonus that will be paid. It used to be hardcoded in the component,
      which is how the page came to advertise a 25,000 bonus for a 15,000 deposit.
    */
    listDepositBonusTiers(),
  ]);

  const currency = session.wallet.currency;
  const balance = Number(session.wallet.available_balance);
  const active = tiers.filter((tier) => tier.owned);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Packages</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Activate a package to earn from its videos, up to a daily limit that resets every
          midnight.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <div className="rounded-2xl border border-border bg-card p-4">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Available balance
          </p>
          <p className="mt-1 text-xl font-bold tracking-tight">{formatMoney(balance, currency)}</p>
        </div>
        <div className="rounded-2xl border border-border bg-card p-4">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Active packages
          </p>
          <p className="mt-1 text-xl font-bold tracking-tight">
            {active.length} of {tiers.length}
          </p>
        </div>
        <div className="rounded-2xl border border-border bg-card p-4">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Today&apos;s package earnings
          </p>
          <p className="mt-1 text-xl font-bold tracking-tight">
            {formatMoney(
              active.reduce((sum, tier) => sum + tier.earnedToday, 0),
              currency,
            )}
          </p>
        </div>
      </div>

      {/*
        Stated once, in plain words, because it is the term a buyer most needs to
        understand and the one an advert would be tempted to blur: a package
        buys access to a bounded daily allowance, not a guaranteed income, and
        the limit is a limit.
      */}
      <Alert variant="info" title="How packages work">
        <ul className="list-disc space-y-1 pl-4">
          <li>The price is paid once, from your wallet balance.</li>
          <li>
            You then earn from that package&apos;s videos until the daily limit is reached. The
            limit resets at midnight (East Africa Time).
          </li>
          <li>
            Reward amounts come from each video&apos;s campaign and are credited only after our
            servers verify your watch time.
          </li>
          <li>
            Activating a package does not guarantee any particular daily or total earnings — the
            limit is the most it can pay, not an amount it will pay.
          </li>
        </ul>
      </Alert>

      {!available ? (
        <PackagesUnavailable />
      ) : (
        <PackagesCatalogue
          tiers={tiers}
          currency={currency}
          balance={balance}
          defaultPhone={session.profile.phone ?? ""}
          bonusTiers={bonusTiers}
        />
      )}

      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <PackageIcon className="h-3.5 w-3.5" aria-hidden />
        A package can only be attached to a video once, so a video never counts towards two daily
        limits at the same time.
      </p>
    </div>
  );
}
