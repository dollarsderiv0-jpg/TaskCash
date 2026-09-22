import Link from "next/link";
import type { Metadata } from "next";
import { Logo } from "@/components/brand/logo";
import { FrontDoorRedirect } from "@/components/auth/front-door-redirect";

/**
 * The front door.
 *
 * What used to be here was the public marketing page — a hero, a mock wallet
 * reading KES 0.00, a trust grid, a four-step explainer, a security list and an
 * FAQ. It was a page of claims that had to be kept true, and every figure on it
 * had to be read from the same settings the product uses so the copy could not
 * drift from what the platform actually does. None of that is what a link
 * shared with somebody is for.
 *
 * So the link now opens the brand mark and goes straight to the account
 * screens. Nothing on this page states a rate, makes a claim, or needs
 * maintaining: it is a logo and a way onward, which is all it has to be.
 *
 * SITS OUTSIDE THE `(site)` GROUP ON PURPOSE
 * ------------------------------------------
 * The `(site)` layout renders the marketing header — the nav, and "Login" /
 * "Create Account" buttons. A splash screen with a sign-up button in its
 * corner is not a splash screen, so this page is a sibling of that group and
 * not a child of it, and no header renders.
 *
 * ROUTING IS NOT DECIDED HERE
 * ---------------------------
 * A signed-in visitor never reaches this page: the session middleware sends
 * them to `/dashboard` before it renders, because it has already resolved the
 * session for the request and this page would otherwise have to pay for an auth
 * round-trip of its own. This page is what a signed-out visitor sees.
 *
 * It is also deliberately free of any auth call, so it stays a static document
 * served straight from the edge. The backstop if the middleware rule is ever
 * dropped is the form itself: `/register` and `/login` both already send a
 * signed-in visitor to the dashboard.
 */

/*
  Where the splash hands over. `/register` because the shared link is how a new
  account usually arrives, and the sign-up form carries "Already have an account?
  Sign in" for everyone else. One constant, so changing it is one line.
*/
const CONTINUE_TO = "/register";

export const metadata: Metadata = {
  title: "TaskCash Pro",
  // A redirect screen has no business in a search index.
  robots: { index: false, follow: false },
};

export default function FrontDoorPage() {
  return (
    <main className="tc-hero-glow flex min-h-dvh flex-col items-center justify-center gap-8 px-6 py-16">
      {/* The mark is itself the way onward, in case the redirect never fires. */}
      <Link href={CONTINUE_TO} aria-label="Continue to TaskCash Pro" className="rounded-2xl">
        <Logo size="lg" className="scale-110" />
      </Link>

      <FrontDoorRedirect to={CONTINUE_TO} />

      <p className="text-xs tracking-wide text-muted-foreground">Just a moment…</p>

      {/*
        Rendered only when scripting is unavailable, which is also when the
        redirect above cannot run — without these the visitor would be left on a
        logo with no way forward.
      */}
      <noscript>
        <div className="flex flex-col items-center gap-3">
          <Link href="/register" className="text-sm font-semibold text-primary hover:underline">
            Create an account
          </Link>
          <Link
            href="/login"
            className="text-sm font-medium text-muted-foreground hover:underline"
          >
            Sign in
          </Link>
        </div>
      </noscript>
    </main>
  );
}
