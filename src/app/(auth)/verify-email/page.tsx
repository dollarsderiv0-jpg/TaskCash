import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth/session";
import { VerifyEmailActions } from "@/components/auth/verify-email-actions";
import { Alert } from "@/components/ui/misc";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export const metadata: Metadata = { title: "Verify your email" };

// The session decides what this page shows, so it can never be cached.
export const dynamic = "force-dynamic";

/**
 * /verify-email
 *
 * Where the verification gate sends people, and where registration lands when
 * email confirmation is on. Two arrivals matter, and they need different things:
 *
 *  - **Signed in and still unverified.** Offer the two useful actions (resend,
 *    change the address) and show which address is waiting.
 *  - **Signed out.** With confirmation enabled, Supabase does not issue a
 *    session at sign-up, so a brand-new user reaches this page with no session
 *    at all. That is expected, not an error, and there is nothing to resend for
 *    a caller we cannot identify — so it points at sign-in instead of pretending.
 *
 * An already-verified visitor is sent on to where they were going. `next` is
 * sanitised to a local path, and `/verify-email` itself is never a target, so
 * this cannot loop.
 */
export default async function VerifyEmailPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const params = await searchParams;
  const requested = params.next ?? "/dashboard";
  const next = requested.startsWith("/") && !requested.startsWith("/verify-email") ? requested : "/dashboard";

  const session = await getSessionUser();

  if (session?.emailConfirmed) {
    redirect(next);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-xl">Verify your email</CardTitle>
        <CardDescription>
          We ask for a verified address before money can be deposited, withdrawn or earned, because an
          unverified account is one somebody can abandon.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {session ? (
          <>
            <Alert variant="info">
              Open the confirmation link we sent to finish setting up your account. If it has not
              arrived, check your spam folder, or request a new one below.
            </Alert>
            <VerifyEmailActions email={session.email} />
          </>
        ) : (
          <>
            <Alert variant="info">
              If you have just registered, check your inbox for the confirmation link — then sign in.
              Nothing is needed from you on this page until you are signed in.
            </Alert>
            <Link
              href={`/login?next=${encodeURIComponent(next)}`}
              className="inline-flex w-full items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
            >
              Sign in
            </Link>
          </>
        )}

        <p className="text-xs text-muted-foreground">
          Received a link that has expired? Confirmation links are single-use and time limited.{" "}
          {/* Only point at the button when it is actually on the page: signed out,
              there is no resend control here, and telling someone to use one that
              does not exist is how a support ticket gets written. */}
          {session ? "Request a new one above" : "Sign in to request a new one"}, or{" "}
          <Link href="/contact" className="underline underline-offset-4">
            contact support
          </Link>
          .
        </p>
      </CardContent>
    </Card>
  );
}
