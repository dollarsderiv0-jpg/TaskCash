import { SiteHeader } from "@/components/marketing/site-header";

/**
 * Rendered per request, not prerendered.
 *
 * The marketing pages quote live platform limits read from the database, so
 * prerendering them at build time would freeze placeholder values into the
 * site until the next deploy.
 */
export const dynamic = "force-dynamic";

export default function SiteLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col">
      <SiteHeader />
      <main id="main" className="flex-1">
        {children}
      </main>
    </div>
  );
}
