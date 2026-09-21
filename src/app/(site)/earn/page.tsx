import type { Metadata } from "next";
import Link from "next/link";
import { Clock, Gift, ListChecks, ShieldCheck, Users } from "lucide-react";
import { Alert } from "@/components/ui/misc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

export const metadata: Metadata = {
  title: "Earn",
  description:
    "The earning activities available on TaskCash Pro: sponsored video campaigns, approved tasks and referral commissions.",
};

export default function EarnPage() {
  return (
    <div className="container max-w-4xl py-14">
      <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">Ways to earn</h1>
      <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted-foreground">
        Every reward on TaskCash Pro comes from completing an eligible activity that our servers can
        verify. Nothing is credited for simply being logged in.
      </p>

      <div className="mt-10 grid gap-5 sm:grid-cols-2">
        <EarnCard
          icon={Clock}
          title="Sponsored video campaigns"
          body="Watch an advertiser's video through to the required duration. Campaigns set their own reward, required watch time, daily limit and budget."
          bullets={[
            "Reward value comes from the campaign record",
            "Server-tracked watch time",
            "Daily limits and cooldowns apply",
          ]}
        />
        <EarnCard
          icon={ListChecks}
          title="Approved tasks"
          body="Where an administrator publishes a task, completing it under its stated rules can earn a task reward. Tasks are added by administrators, not by users."
          bullets={[
            "Rules are published on the task itself",
            "Rewards are configurable per task",
            "Subject to the same verification rules",
          ]}
        />
        <EarnCard
          icon={Users}
          title="Referral commissions"
          body="Earn commission when someone you invited completes the configured qualifying event and then engages in eligible activity."
          bullets={[
            "One level by default",
            "Rate configured by administrators",
            "Self-referrals and duplicates are blocked",
          ]}
        />
        <EarnCard
          icon={Gift}
          title="Administrator-created campaigns"
          body="Other earning campaigns can be published by administrators — for example themed promotions — always with an explicit budget and rule set."
          bullets={[
            "Budget-limited, so rewards stop when exhausted",
            "Eligibility rules are enforced server-side",
            "Every payout is written to your ledger",
          ]}
        />
      </div>

      <Alert variant="warning" className="mt-8" title="What we never do">
        <ul className="space-y-2">
          <li>We never advertise a guaranteed daily or monthly return.</li>
          <li>We never describe a deposit as an investment that pays profit or interest.</li>
          <li>We never credit a reward because the browser said an activity was completed.</li>
          <li>We never pay a withdrawal automatically without administrator review.</li>
        </ul>
      </Alert>

      <Card className="mt-8">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-orangeBrand-500" aria-hidden />
            Why verification is strict
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm leading-relaxed text-muted-foreground">
          <p>
            Campaign budgets are funded by advertisers. If watch time could be faked, budgets would
            be consumed by invalid activity and legitimate users would lose access to campaigns.
          </p>
          <p>
            That is why the reward value is never sent by your device, why progress is clamped to
            real elapsed time, and why each watch session can only be rewarded once.
          </p>
        </CardContent>
      </Card>

      <div className="mt-8 flex flex-col gap-3 sm:flex-row">
        <Button asChild size="lg">
          <Link href="/register">Create an account to start</Link>
        </Button>
        <Button asChild size="lg" variant="outline">
          <Link href="/rewards-policy">Read the Rewards Policy</Link>
        </Button>
      </div>
    </div>
  );
}

function EarnCard({
  icon: Icon,
  title,
  body,
  bullets,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  body: string;
  bullets: string[];
}) {
  return (
    <Card className="h-full">
      <CardHeader className="pb-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-orangeBrand-500/12">
          <Icon className="h-5 w-5 text-orangeBrand-500" aria-hidden />
        </div>
        <CardTitle className="mt-2">{title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm leading-relaxed text-muted-foreground">{body}</p>
        <ul className="space-y-1.5 text-xs text-muted-foreground">
          {bullets.map((bullet) => (
            <li key={bullet} className="flex gap-2">
              <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-primary/70" />
              <span>{bullet}</span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
