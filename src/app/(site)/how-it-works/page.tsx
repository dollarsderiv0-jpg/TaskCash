import type { Metadata } from "next";
import Link from "next/link";
import { Alert } from "@/components/ui/misc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { getPublicSettings } from "@/lib/settings";

export const metadata: Metadata = {
  title: "How It Works",
  description:
    "How TaskCash Pro accounts, eligible activities, server-verified rewards and administrator-reviewed withdrawals work.",
};

export const dynamic = "force-dynamic";

const STAGES = [
  {
    title: "Create your account",
    body: [
      "Register with your full name, email address, mobile money number, country and currency.",
      "A wallet is created for you automatically, along with your unique referral code.",
      "Your account details, wallet and referral relationship are provisioned by the server — you cannot set your own balance or role.",
    ],
  },
  {
    title: "Complete an eligible activity",
    body: [
      "Open the Watch & Earn page to see campaigns that are currently active and payable.",
      "Each campaign shows its own duration, required watch time and reward.",
      "When you start a video, the server records the start time. Progress is measured against real elapsed time, so the number cannot be inflated by your device.",
    ],
  },
  {
    title: "Your reward is verified and credited",
    body: [
      "The server checks the campaign status, campaign budget, view limits, your daily limits, cooldowns and account eligibility.",
      "If everything passes, the reward value is read from the campaign record and written to your wallet ledger with a unique reference.",
      "A session can only ever be rewarded once, even if the app is closed mid-way — use the recovery action on the wallet page and the same session is re-checked.",
    ],
  },
  {
    title: "Request a withdrawal",
    body: [
      "When your available balance reaches the minimum, request a payout to your mobile money number.",
      "The amount moves from available to locked while the request is under review. This reserves it without spending it.",
      "Our administration team reviews the request. If it is approved, payment is initiated and only marked completed once the provider confirms it. If it is rejected, the funds return to your available balance.",
    ],
  },
];

export default async function HowItWorksPage() {
  const settings = await getPublicSettings();

  return (
    <div className="container max-w-4xl py-14">
      <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">How TaskCash Pro Works</h1>
      <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted-foreground">
        TaskCash Pro rewards eligible activity. This page explains the whole process in the order it
        happens, including the checks that decide whether a reward is issued.
      </p>

      <Alert variant="info" className="mt-6" title="Rewards are not guaranteed income">
        <p>
          Rewards depend on which campaigns are active and on their remaining budgets. We do not
          promise a fixed daily, weekly or monthly amount, and deposits are never presented as an
          investment.
        </p>
      </Alert>

      <div className="mt-10 space-y-5">
        {STAGES.map((stage, index) => (
          <Card key={stage.title} id={`stage-${index + 1}`}>
            <CardHeader>
              <div className="flex items-center gap-3">
                <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-primary/12 text-sm font-bold text-primary">
                  {index + 1}
                </span>
                <CardTitle className="text-lg">{stage.title}</CardTitle>
              </div>
            </CardHeader>
            <CardContent className="space-y-2.5">
              {stage.body.map((line) => (
                <p key={line.slice(0, 30)} className="text-sm leading-relaxed text-muted-foreground">
                  {line}
                </p>
              ))}
            </CardContent>
          </Card>
        ))}
      </div>

      <Card className="mt-8">
        <CardHeader>
          <CardTitle>Current platform rules</CardTitle>
        </CardHeader>
        <CardContent>
          {/*
            Deliberately no amounts. The deposit and withdrawal bounds are shown
            inside the app on the wallet screen, not published here, so this table
            carries the rules that are not figures.
          */}
          <dl className="grid gap-x-8 gap-y-4 text-sm sm:grid-cols-2">
            <Row
              label="Deposit and withdrawal amounts"
              value="Shown in the app, on your wallet screen"
            />
            <Row
              label="Withdrawal review"
              value="Checked by a person before payment"
            />
            <Row
              label="Referral commission"
              value={`${Math.round(settings.level1Rate * 100)}% of eligible activity`}
            />
            <Row
              label="Identity verification for withdrawals"
              value={settings.requireVerifiedKyc ? "Required" : "Not currently required"}
            />
          </dl>
          <p className="mt-5 text-xs text-muted-foreground">
            These values are set by platform administrators and may change. The authoritative values
            are always the ones shown on the deposit and withdrawal screens when you use them.
          </p>
        </CardContent>
      </Card>

      <div className="mt-8 flex flex-col gap-3 sm:flex-row">
        <Button asChild size="lg">
          <Link href="/register">Create your account</Link>
        </Button>
        <Button asChild size="lg" variant="outline">
          <Link href="/faq">Read the FAQ</Link>
        </Button>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-border pb-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-semibold">{value}</dd>
    </div>
  );
}
