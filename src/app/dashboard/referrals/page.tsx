import type { Metadata } from "next";
import { Gift, Users } from "lucide-react";
import { guardVerifiedPage } from "@/lib/auth/guards";
import {
  getReferralStats,
  listReferrals,
  qualifyingEventCopy,
  referralLink,
} from "@/server/services/referrals";
import { ReferralShare } from "@/components/app/referral-share";
import { StatCard } from "@/components/app/stat-card";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, Badge, EmptyState, statusBadgeVariant } from "@/components/ui/misc";
import { formatDate, formatMoney } from "@/lib/money/format";
import { statusLabel } from "@/lib/types";

export const metadata: Metadata = { title: "Referrals" };

export const dynamic = "force-dynamic";

export default async function ReferralsPage() {
  const session = await guardVerifiedPage("/dashboard/referrals");
  const [stats, referrals] = await Promise.all([
    getReferralStats(session.profile.id),
    listReferrals(session.profile.id),
  ]);

  const currency = session.wallet.currency;
  const code = session.profile.referral_code;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Referrals</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Invite people who will genuinely use the platform. Commissions follow eligible activity —
          not link clicks.
        </p>
      </div>

      {!stats.enabled ? (
        <Alert variant="warning" title="Referral program is paused">
          <p>
            New commissions are not being created right now. Any commission already credited to your
            wallet is unaffected.
          </p>
        </Alert>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Invite &amp; earn</CardTitle>
          <CardDescription>{qualifyingEventCopy(stats.qualifyingEvent)}</CardDescription>
        </CardHeader>
        <CardContent>
          <ReferralShare code={code} link={referralLink(code)} />
        </CardContent>
      </Card>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Total referrals" value={String(stats.totalReferrals)} icon={Users} />
        <StatCard
          label="Qualifying referrals"
          value={String(stats.qualifyingReferrals)}
          hint={`${stats.pendingReferrals} pending`}
          icon={Gift}
          tone="success"
        />
        <StatCard
          label="Referral earnings"
          value={formatMoney(stats.totalEarned, currency)}
          hint="Credited to your wallet"
          tone="success"
        />
        <StatCard
          label="Pending commissions"
          value={formatMoney(stats.pendingCommissions, currency)}
          hint="Not yet credited"
          tone="warning"
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Current commission rates</CardTitle>
          <CardDescription>
            Rates are configured by administrators and are recorded on each commission when it is
            created.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-3">
          <Rate label="Direct (level 1)" value={`${Math.round(stats.level1Rate * 100)}%`} />
          <Rate
            label="Second level"
            value={stats.level2Rate > 0 ? `${Math.round(stats.level2Rate * 100)}%` : "Not active"}
          />
          <Rate
            label="Signup bonus"
            value={stats.signupBonus > 0 ? formatMoney(stats.signupBonus, currency) : "Not active"}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Your referrals</CardTitle>
          <CardDescription>
            Names are partially masked — you can see your commissions, not other people&apos;s
            personal details.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {referrals.length === 0 ? (
            <EmptyState
              icon={Users}
              title="No referrals yet"
              description="Share your referral code. Once someone registers with it, they will appear here."
              className="py-8"
            />
          ) : (
            <ul className="divide-y divide-border">
              {referrals.map((referral) => (
                <li key={referral.id} className="flex items-center justify-between gap-4 py-3.5">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{referral.maskedName}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      Joined {formatDate(referral.createdAt)}
                      {referral.qualifiedAt ? ` · qualified ${formatDate(referral.qualifiedAt)}` : ""}
                    </p>
                    {referral.qualifyingEvent ? (
                      <p className="mt-0.5 text-[11px] text-muted-foreground">
                        {qualifyingEventCopy(referral.qualifyingEvent)}
                      </p>
                    ) : null}
                  </div>
                  <div className="shrink-0 text-right">
                    <Badge variant={statusBadgeVariant(referral.status)}>
                      {statusLabel(referral.status)}
                    </Badge>
                    <p className="mt-1.5 text-xs font-semibold tabular-nums tc-amount-in">
                      {formatMoney(referral.commissionTotal, currency)}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Alert variant="warning" title="Fair use">
        <p>
          Self-referrals, duplicate accounts and circular referral structures are blocked in the
          database. Accounts used to farm commissions are reviewed by our team and may be suspended.
        </p>
      </Alert>
    </div>
  );
}

function Rate({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-border bg-background p-4">
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-1 text-lg font-bold">{value}</p>
    </div>
  );
}
