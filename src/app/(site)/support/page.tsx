import type { Metadata } from "next";
import Link from "next/link";
import { AlertCircle, Clock, LifeBuoy, Mail, Phone, Receipt, ShieldCheck } from "lucide-react";
import { getPublicSettings } from "@/lib/settings";
import { getSessionUser } from "@/lib/auth/session";
import { isSupportConfigured, listOwnTicketsWithMessages } from "@/server/services/support";
import { HelpSearch } from "@/components/support/help-search";
import { SupportForm } from "@/components/app/support-form";
import { Alert, Badge, EmptyState, Separator, statusBadgeVariant } from "@/components/ui/misc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDateTime } from "@/lib/money/format";
import { supportCategoryLabel, supportStatusLabel } from "@/lib/types";

export const metadata: Metadata = {
  title: "Help & Support",
  description:
    "Answers about rewards, deposits, withdrawals, referrals and account security, plus how to reach TaskCash Pro support.",
};

export const dynamic = "force-dynamic";

const NOT_CONFIGURED = "Not configured — see Settings → Platform details";

export default async function SupportPage() {
  const [settings, session] = await Promise.all([getPublicSettings(), getSessionUser()]);

  // The support tables arrive in migration 0006. Until they are applied the page
  // still helps — search, answers, contact details — and only the ticket form is
  // withheld, so nothing here is a button that cannot work.
  //
  // Only asked when there is a session, because the form and the request list are
  // the only things that depend on it. A signed-out visitor gets the sign-in
  // branch either way, and probing as anonymous is what produced the bare 401.
  const configured = session ? await isSupportConfigured() : false;
  const tickets = session && configured ? await listOwnTicketsWithMessages(session.profile.id) : [];

  const identity = settings.identity;
  const hasEmail = identity.supportEmail !== NOT_CONFIGURED;
  const hasPhone = identity.supportPhone !== NOT_CONFIGURED;

  return (
    <div className="container max-w-3xl py-12">
      <div className="flex items-center gap-3">
        <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-primary/10 text-primary">
          <LifeBuoy className="h-5 w-5" aria-hidden />
        </span>
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Help & Support</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Find an answer, or send us a request and we will get back to you.
          </p>
        </div>
      </div>

      {/* ---------------------------------------------------------------- */}
      {/* Help content                                                      */}
      {/* ---------------------------------------------------------------- */}
      <div className="mt-10">
        <HelpSearch />
      </div>

      <Separator className="my-10" />

      {/* ---------------------------------------------------------------- */}
      {/* The numbers, in the open                                          */}
      {/* ---------------------------------------------------------------- */}
      <section aria-labelledby="money-facts" className="space-y-4">
        <h2 id="money-facts" className="flex items-center gap-2 text-lg font-semibold tracking-tight">
          <ShieldCheck className="h-4 w-4 text-orangeBrand-500" aria-hidden />
          The important money facts
        </h2>
        {/*
          The figures that used to sit here — deposit floor and ceiling, withdrawal
          minimum and maximum, the daily ceiling and the fee — are no longer
          published. They appear on the wallet screen inside the app instead. What
          remains is the part a user needs before they ever sign up: that nobody is
          paid automatically.
        */}
        <Card>
          <CardContent className="grid gap-4 p-5 sm:grid-cols-2">
            <Fact
              label="Withdrawal review"
              value="Checked by a person before payment"
            />
            <Fact
              label="Deposit and withdrawal amounts"
              value="Shown in the app, on your wallet screen"
            />
            <Fact
              label="Identity verification for withdrawals"
              value={settings.requireVerifiedKyc ? "Required" : "Not currently required"}
            />
            <Fact
              label="Referral commission"
              value={`${Math.round(settings.level1Rate * 100)}% of eligible activity`}
            />
          </CardContent>
        </Card>
        <p className="text-xs leading-relaxed text-muted-foreground">
          Withdrawals are never sent automatically — every request is reviewed first, which means
          a payout is not instant. Processing can take longer when a payment provider request
          needs to be retried. See the{" "}
          <Link className="underline underline-offset-2" href="/withdrawal-policy">
            withdrawal policy
          </Link>{" "}
          and{" "}
          <Link className="underline underline-offset-2" href="/rewards-policy">
            rewards policy
          </Link>{" "}
          for the full terms.
        </p>
      </section>

      <Separator className="my-10" />

      {/* ---------------------------------------------------------------- */}
      {/* Contact channels                                                  */}
      {/* ---------------------------------------------------------------- */}
      <section aria-labelledby="contact-channels" className="space-y-4">
        <h2 id="contact-channels" className="text-lg font-semibold tracking-tight">
          Contact us
        </h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <Mail className="h-4 w-4 text-orangeBrand-500" aria-hidden />
                Email support
              </CardTitle>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">
              {hasEmail ? (
                <a className="underline underline-offset-2" href={`mailto:${identity.supportEmail}`}>
                  {identity.supportEmail}
                </a>
              ) : (
                <p>Support details have not been published by the operator yet.</p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <Phone className="h-4 w-4 text-orangeBrand-500" aria-hidden />
                Phone support
              </CardTitle>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">
              {hasPhone ? <p>{identity.supportPhone}</p> : <p>Not published yet.</p>}
            </CardContent>
          </Card>
        </div>
      </section>

      <Separator className="my-10" />

      {/* ---------------------------------------------------------------- */}
      {/* Report a payment problem                                          */}
      {/* ---------------------------------------------------------------- */}
      <section aria-labelledby="report-problem" className="space-y-4">
        <h2
          id="report-problem"
          className="flex items-center gap-2 text-lg font-semibold tracking-tight"
        >
          <AlertCircle className="h-4 w-4 text-orangeBrand-500" aria-hidden />
          Report a payment problem
        </h2>

        {!session ? (
          <Alert variant="info" title="Sign in to send a request">
            <p>
              We attach requests to your account so we can look at the actual payment records with
              you. Please{" "}
              <Link className="underline underline-offset-2" href="/login?next=/support">
                sign in
              </Link>{" "}
              and send it from there. Urgent account access problems can also be emailed to us.
            </p>
          </Alert>
        ) : !configured ? (
          <Alert variant="warning" title="Support requests are being set up">
            <p>
              The in-app request form is not available on this deployment yet. Nothing has been lost
              — please reach us through the contact details above, or{" "}
              <Link className="underline underline-offset-2" href="/contact">
                the contact page
              </Link>
              , and include the reference from your transaction history.
            </p>
          </Alert>
        ) : (
          <Card>
            <CardHeader>
              <CardTitle>Send a request</CardTitle>
              <CardDescription>
                Include the reference from Wallet → Transaction history so we can find the payment.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <SupportForm supportEmail={hasEmail ? identity.supportEmail : null} />
            </CardContent>
          </Card>
        )}
      </section>

      {/* ---------------------------------------------------------------- */}
      {/* Existing requests                                                 */}
      {/* ---------------------------------------------------------------- */}
      {session && configured ? (
        <>
          <Separator className="my-10" />
          <section aria-labelledby="my-requests" className="space-y-4">
            <h2 id="my-requests" className="text-lg font-semibold tracking-tight">
              Your support requests
            </h2>

            {tickets.length === 0 ? (
              <EmptyState
                icon={Receipt}
                title="No requests yet"
                description="When you send us a request it will appear here with our replies."
                className="py-8"
              />
            ) : (
              <ul className="space-y-4">
                {tickets.map(({ ticket, messages }) => (
                  <li key={ticket.id}>
                    <Card>
                      <CardHeader className="pb-3">
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <div className="min-w-0">
                            <CardTitle className="text-base">{ticket.subject}</CardTitle>
                            <CardDescription className="mt-1">
                              <span className="font-mono">{ticket.reference}</span> ·{" "}
                              {supportCategoryLabel(ticket.category)} ·{" "}
                              {formatDateTime(ticket.created_at)}
                            </CardDescription>
                          </div>
                          <Badge variant={statusBadgeVariant(ticket.status)}>
                            {supportStatusLabel(ticket.status)}
                          </Badge>
                        </div>
                      </CardHeader>
                      <CardContent className="space-y-3">
                        {messages.map((entry) => (
                          <div
                            key={entry.id}
                            className={
                              entry.author_role === "ADMIN"
                                ? "rounded-xl border border-primary/25 bg-primary/5 p-3"
                                : "rounded-xl border border-border bg-muted/20 p-3"
                            }
                          >
                            <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                              {entry.author_role === "ADMIN" ? "TaskCash Pro" : "You"} ·{" "}
                              {formatDateTime(entry.created_at)}
                            </p>
                            <p className="mt-1 whitespace-pre-wrap text-sm">{entry.body}</p>
                          </div>
                        ))}
                        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                          <Clock className="h-3.5 w-3.5" aria-hidden />
                          Replies arrive on this page. You will be notified when anything changes.
                        </p>
                      </CardContent>
                    </Card>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      ) : null}

      <div className="mt-10 flex flex-wrap gap-3">
        <Button asChild variant="outline">
          <Link href="/faq">Full FAQ</Link>
        </Button>
        <Button asChild variant="outline">
          <Link href="/contact">Contact page</Link>
        </Button>
        <Button asChild variant="outline">
          <Link href="/how-it-works">How TaskCash works</Link>
        </Button>
      </div>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-0.5 text-sm font-semibold tabular-nums">{value}</p>
    </div>
  );
}
