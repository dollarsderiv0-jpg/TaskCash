import Link from "next/link";
import { Logo } from "@/components/brand/logo";
import { Alert } from "@/components/ui/misc";
import {
  PLATFORM_NOT_CONFIGURED_MESSAGE,
  hasSupabaseAdminCredentials,
  missingServerConfigKeys,
} from "@/lib/env";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  // Better to say this before someone fills in a form that cannot succeed.
  //
  // Deliberately the SERVER-side check, not just the public one: a deployment
  // with a URL and a publishable key but no secret key can render the form yet
  // still refuse every sign-up at the API. Public-only configuration would
  // hide this banner and let someone fill in a form that cannot succeed.
  const configured = hasSupabaseAdminCredentials();
  // Outside production an operator gets the exact variable names to set; in
  // production the message stays generic. Names only — never values.
  const missing = configured || process.env.NODE_ENV === "production" ? [] : missingServerConfigKeys();


  return (
    /*
      Phone first, like the forms inside it.

      The header, the padding around the card and the footer are all chrome, and
      on a short screen they were taking roughly 200px of the height the sign-up
      form needed — the form is the thing that has to fit. Each reverts to the
      roomier value at `sm`, where the space costs nothing.
    */
    <div className="tc-hero-glow flex min-h-dvh flex-col">
      <header className="container flex h-14 items-center justify-between sm:h-16">
        <Link href="/" aria-label="TaskCash Pro home">
          <Logo />
        </Link>
        <Link
          href="/"
          className="text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          Back to site
        </Link>
      </header>

      <main id="main" className="container flex flex-1 items-start justify-center py-4 sm:items-center sm:py-8">
        <div className="w-full max-w-md space-y-3 sm:space-y-4">
          {!configured ? (
            <Alert variant="warning" title="Platform setup incomplete">
              <p>{PLATFORM_NOT_CONFIGURED_MESSAGE}</p>
              {missing.length > 0 ? (
                <p className="mt-2 text-xs leading-relaxed">
                  Missing from <code className="font-mono">.env.local</code>:{" "}
                  <span className="font-mono">{missing.join(", ")}</span>. Run{" "}
                  <code className="font-mono">npm run preflight</code> for the full checklist, or see{" "}
                  <code className="font-mono">.freebuff/run.md</code>.
                </p>
              ) : null}
            </Alert>
          ) : null}
          {children}
        </div>
      </main>

      <footer className="container py-4 text-center text-[11px] text-muted-foreground sm:py-6 sm:text-xs">
        <p>
          TaskCash Pro is a rewards platform. Rewards depend on eligible activities and campaign
          rules — no return is guaranteed.
        </p>
        <div className="mt-2 flex flex-wrap justify-center gap-x-4 gap-y-1">
          <Link className="hover:text-foreground" href="/terms">
            Terms
          </Link>
          <Link className="hover:text-foreground" href="/privacy">
            Privacy
          </Link>
          <Link className="hover:text-foreground" href="/responsible-use">
            Responsible Use
          </Link>
        </div>
      </footer>
    </div>
  );
}
