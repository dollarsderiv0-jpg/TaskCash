"use client";

import * as React from "react";
import { Check, Copy, Share2, UserPlus } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { PageHeader } from "@/components/page-header";
import { PrimaryButton } from "@/components/primary-button";
import { StatCard } from "@/components/stat-card";
import { StatusBadge } from "@/components/status-badge";
import { useToast } from "@/components/toast";
import { formatDate, formatMoneyCompact } from "@/lib/format";
import { useStore } from "@/lib/store";

export default function ReferralsPage() {
  const { state } = useStore();
  const toast = useToast();
  const { referral } = state;
  const [copied, setCopied] = React.useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(referral.code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
      toast.success("Referral code copied", referral.code);
    } catch {
      toast.error("Could not copy", "Copy the code manually instead.");
    }
  };

  const share = async () => {
    const payload = {
      title: "TaskCash Pro",
      text: `Join TaskCash Pro with my referral code ${referral.code}`,
    };
    /* Web Share is unavailable on desktop Chrome and most in-app browsers, so
       the fallback matters more than the happy path here. */
    if (typeof navigator !== "undefined" && navigator.share) {
      try {
        await navigator.share(payload);
        return;
      } catch {
        /* User dismissed the sheet — fall through to copying. */
      }
    }
    await copy();
  };

  return (
    <AppShell>
      <PageHeader
        title="Refer &amp; Earn"
        subtitle="Invite friends and earn a bonus once they activate their first package."
      />

      <div className="tc-card relative overflow-hidden p-4 sm:p-5">
        <div
          aria-hidden
          className="pointer-events-none absolute -left-16 -top-20 h-48 w-48 rounded-full bg-flame/15 blur-3xl"
        />
        <div className="relative">
          <p className="tc-label">Your referral code</p>
          <div className="mt-2 flex flex-wrap items-center gap-2.5">
            <span className="tnum rounded-tile border border-dashed border-flame/50 bg-flame/[0.08] px-4 py-2.5 text-lg font-extrabold tracking-[0.18em] text-white">
              {referral.code}
            </span>
            <PrimaryButton variant="outline" size="md" onClick={copy}>
              {copied ? <Check className="h-4 w-4 text-cash" aria-hidden /> : <Copy className="h-4 w-4" aria-hidden />}
              {copied ? "Copied" : "Copy Code"}
            </PrimaryButton>
            <PrimaryButton variant="ghost" size="md" onClick={share}>
              <Share2 className="h-4 w-4" aria-hidden />
              Share
            </PrimaryButton>
          </div>
          <p className="mt-2.5 text-[11px] leading-snug text-muted">
            Your friend enters this code at sign-up. Bonuses are credited to your wallet as mock
            entries and are not withdrawable in the prototype.
          </p>
        </div>
      </div>

      <div className="mt-3 grid grid-cols-3 gap-3">
        <StatCard
          label="Total referrals"
          value={String(referral.totalReferrals)}
          icon={<UserPlus aria-hidden />}
        />
        <StatCard label="Active referrals" value={String(referral.activeReferrals)} tone="positive" />
        <StatCard label="Referral earnings" value={formatMoneyCompact(referral.earnings)} />
      </div>

      <section className="tc-card mt-4 overflow-hidden p-0" aria-labelledby="invitees">
        <h2
          id="invitees"
          className="border-b border-hairline px-4 py-3 text-[15px] font-bold tracking-tight text-white"
        >
          People you invited
        </h2>
        <ul className="divide-y divide-hairline/70">
          {referral.invitees.map((invitee) => (
            <li key={invitee.id} className="flex items-center gap-3 px-4 py-3">
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-brand/15 text-[11px] font-bold text-brand-400">
                {invitee.name.slice(0, 1)}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-semibold text-white">{invitee.name}</p>
                <p className="text-[11px] text-muted">Joined {formatDate(invitee.joinedAt)}</p>
              </div>
              <div className="flex shrink-0 items-center gap-2.5">
                <span className="tnum text-[13px] font-bold text-cash">
                  +{formatMoneyCompact(invitee.earned)}
                </span>
                <StatusBadge tone={invitee.status === "active" ? "active" : "pending"}>
                  {invitee.status}
                </StatusBadge>
              </div>
            </li>
          ))}
        </ul>
      </section>
    </AppShell>
  );
}
