import type { Metadata } from "next";
import Link from "next/link";
import { Alert } from "@/components/ui/misc";

export const metadata: Metadata = {
  title: "FAQ",
  description:
    "Answers about earning, rewards, deposits, withdrawals, referrals, verification and account security on TaskCash Pro.",
};

const GROUPS: { title: string; items: { q: string; a: string }[] }[] = [
  {
    title: "Getting started",
    items: [
      {
        q: "What is TaskCash Pro?",
        a: "A rewards platform. You complete eligible online activities — mainly sponsored video campaigns and approved tasks — and rewards are credited to an internal wallet ledger that records every money movement.",
      },
      {
        q: "What do I need to register?",
        a: "Your full name, email address, a mobile money number, your country and your currency. Your wallet and a unique referral code are created automatically.",
      },
      {
        q: "Is TaskCash Pro a bank or an investment platform?",
        a: "No. We are not a bank, a licensed payment service provider, an investment manager or a financial adviser. We do not offer guaranteed returns, interest or profit on deposits.",
      },
    ],
  },
  {
    title: "Earning and rewards",
    items: [
      {
        q: "How much will I earn?",
        a: "It depends entirely on which campaigns are active, what reward each campaign sets, and how much of its budget remains. We deliberately do not advertise a fixed daily or monthly figure because we cannot guarantee one.",
      },
      {
        q: "Why did a video not pay out?",
        a: "The most common reasons are that the required watch time was not met, the campaign's daily limit for your account was reached, the campaign's reward budget was exhausted, or the campaign was paused or ended. The specific reason is shown when the session is processed.",
      },
      {
        q: "Can I watch the same video repeatedly?",
        a: "Each campaign sets its own daily limit and cooldown. Once you reach the limit for a video, it will not pay again until the limit resets. Campaign budgets are a hard ceiling: when they run out, rewards stop for that campaign.",
      },
      {
        q: "I closed the app during a video. Did I lose the reward?",
        a: "Not necessarily. If the server had already observed enough time, the wallet page offers a recovery action which re-checks your sessions and credits anything that qualifies. A session can still only be rewarded once.",
      },
    ],
  },
  {
    title: "Deposits",
    items: [
      {
        q: "Why would I deposit?",
        a: "Some platform plans require a deposit for access to certain features. Where that applies, the requirement is stated on the deposit screen. A deposit is a payment for platform services — it is not an investment.",
      },
      {
        q: "When is my deposit credited?",
        a: "Only after our payment partner independently confirms the transaction. A payment that is still pending is never added to your balance, and we never credit a deposit because a browser claimed it succeeded.",
      },
      {
        q: "My payment is pending. What should I do?",
        a: "Approve the payment prompt on your phone if you received one, then use the verify action on your deposit. If it stays pending, the platform re-checks unresolved payments automatically and our team can reconcile it from the provider record.",
      },
    ],
  },
  {
    title: "Withdrawals",
    items: [
      {
        q: "Why do withdrawals need approval?",
        a: "Every payout is reviewed by our administration team before money leaves the platform. That review is what allows us to catch duplicate requests, compromised accounts and fraud before funds are sent.",
      },
      {
        q: "How long does a withdrawal take?",
        a: "A request is queued for review as soon as you submit it. Once approved, payment is initiated to your mobile money number and completes when the provider confirms it. Timing depends on the provider and on how long the review takes.",
      },
      {
        q: "What is locked balance?",
        a: "When you request a withdrawal, that amount is moved from your available balance into your locked balance. It is still your money, but it is reserved and cannot be spent or requested again while the request is open. If the request is rejected or the payout fails, it returns to available.",
      },
      {
        q: "Can I withdraw to someone else's number?",
        a: "You should only withdraw to a number you control. Funds sent to a wrong or third-party number may not be recoverable.",
      },
    ],
  },
  {
    title: "Referrals",
    items: [
      {
        q: "When do I earn referral commission?",
        a: "Only after your referral completes the configured qualifying event, and only on their eligible activity at the rate published in the referral program at that time. Opening your link alone earns nothing.",
      },
      {
        q: "Can I refer myself or create accounts to farm commissions?",
        a: "No. Self-referrals are rejected by the database, duplicates and circular structures are blocked, and referral-heavy patterns are flagged for human review. Accounts used to farm commissions are reviewed and may be suspended.",
      },
    ],
  },
  {
    title: "Security and account",
    items: [
      {
        q: "How is my account protected?",
        a: "Sign-in is rate limited per IP address and per account, sessions are validated server-side on every request, and row-level security means your account can only read its own records. Your browser can never set a balance, a reward amount or a transaction status.",
      },
      {
        q: "Will anyone ever ask for my password or a code?",
        a: "No. Nobody from TaskCash Pro will ask for your password, a one-time code, or a fee to release your earnings. Treat any such request as fraud.",
      },
    ],
  },
];

export default function FaqPage() {
  return (
    <div className="container max-w-3xl py-14">
      <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">Frequently Asked Questions</h1>
      <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
        If your question is not answered here, the contact details for support are on our{" "}
        <Link className="underline underline-offset-2" href="/contact">
          contact page
        </Link>
        .
      </p>

      <div className="mt-10 space-y-10">
        {GROUPS.map((group) => (
          <section key={group.title}>
            <h2 className="text-lg font-semibold tracking-tight">{group.title}</h2>
            <div className="mt-4 space-y-3">
              {group.items.map((item) => (
                <details
                  key={item.q}
                  className="group rounded-2xl border border-border bg-card px-5 py-4 [&_summary::-webkit-details-marker]:hidden"
                >
                  <summary className="flex cursor-pointer items-center justify-between gap-4 text-sm font-semibold">
                    {item.q}
                    <span
                      aria-hidden
                      className="text-muted-foreground transition-transform group-open:rotate-45"
                    >
                      +
                    </span>
                  </summary>
                  <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{item.a}</p>
                </details>
              ))}
            </div>
          </section>
        ))}
      </div>

      <Alert variant="warning" className="mt-10" title="No guaranteed earnings">
        <p>
          Nothing on this page is a promise of income. Rewards depend on campaign availability,
          budgets and your eligibility, and withdrawals are subject to administrator review.
        </p>
      </Alert>
    </div>
  );
}
