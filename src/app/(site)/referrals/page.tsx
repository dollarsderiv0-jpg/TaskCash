import type { Metadata } from "next";
import Link from "next/link";
import { Alert } from "@/components/ui/misc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { formatMoney } from "@/lib/money/format";
import { getPublicSettings } from "@/lib/settings";
import { QUALIFYING_EVENT_COPY } from "@/server/services/referrals";

export const metadata: Metadata = {
  title: "Referral Program",
  description:
    "How the TaskCash Pro referral program works: qualifying events, commission rates and the anti-abuse rules that apply.",
};

export const dynamic = "force-dynamic";

export default async function ReferralProgramPage() {
  const settings = await getPublicSettings();
  const level1 = Math.round(settings.level1Rate * 100);
  const level2 = Math.round(settings.level2Rate * 100);
  const qualifyCopy =
    QUALIFYING_EVENT_COPY[settings.referralQualifyingEvent] ??
    "They complete the configured qualifying activity.";

  return (
    <div className="container max-w-4xl py-14">
      <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">Referral Program</h1>
      <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted-foreground">
        Invite people who will genuinely use the platform. Commissions are earned on eligible
        activity — not simply because someone opened your link.
      </p>

      <Alert
        variant={settings.referralsEnabled ? "info" : "warning"}
        className="mt-6"
        title={settings.referralsEnabled ? "Referrals are currently active" : "Referrals are currently paused"}
      >
        <p>
          {settings.referralsEnabled
            ? "The rates below are the ones in force right now. They are set by administrators and may change; the rate applied to a commission is recorded on that commission."
            : "The referral program is paused. Existing commissions already credited to wallets are unaffected."}
        </p>
      </Alert>

      <div className="mt-8 grid gap-5 sm:grid-cols-3">
        <RateCard label="Direct referral commission" value={`${level1}%`} note="Level 1" />
        <RateCard
          label="Second-level commission"
          value={level2 > 0 ? `${level2}%` : "Not active"}
          note="Level 2"
        />
        <RateCard
          label="Signup bonus"
          value={settings.signupBonus > 0 ? formatMoney(settings.signupBonus, "KES") : "Not active"}
          note="On qualification"
        />
      </div>

      <Card className="mt-8">
        <CardHeader>
          <CardTitle>How a referral qualifies</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm leading-relaxed text-muted-foreground">
          <p>
            A referral stays <strong className="text-foreground">pending</strong> until the
            configured qualifying event happens: {qualifyCopy.toLowerCase()}
          </p>
          <p>
            Only after qualification do commissions accrue. From then on, the configured percentage
            of that person&apos;s eligible deposits is credited to your wallet as a referral reward,
            written to your ledger like any other transaction.
          </p>
          <p>
            A second-level rate can be enabled by administrators. By default the program pays one
            level only.
          </p>
        </CardContent>
      </Card>

      <Card className="mt-5">
        <CardHeader>
          <CardTitle>Anti-abuse rules</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="space-y-2.5 text-sm text-muted-foreground">
            {[
              "You cannot refer yourself — the database rejects a self-referral outright.",
              "Each referred account can only ever be attributed to one referrer.",
              "Circular referral structures are rejected.",
              "A commission can only be created once per qualifying event; duplicates are blocked by a unique constraint.",
              "Referral-heavy earning patterns are flagged for human review rather than acted on automatically.",
            ].map((item) => (
              <li key={item} className="flex gap-2.5">
                <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary/70" />
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      <div className="mt-8 flex flex-col gap-3 sm:flex-row">
        <Button asChild size="lg">
          <Link href="/register">Create an account to get your code</Link>
        </Button>
        <Button asChild size="lg" variant="outline">
          <Link href="/terms">Read the Terms</Link>
        </Button>
      </div>
    </div>
  );
}

function RateCard({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <Card>
      <CardContent className="p-5">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">{note}</p>
        <p className="mt-2 text-2xl font-bold tracking-tight">{value}</p>
        <p className="mt-1 text-xs text-muted-foreground">{label}</p>
      </CardContent>
    </Card>
  );
}
